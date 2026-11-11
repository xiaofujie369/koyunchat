package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Site struct {
	ID         int64
	Name       string
	Key        string
	Domains    string
	Color      string
	Title      string
	Welcome    string
	OfflineMsg string
	Position   string
	AIMode     string
	AIName     string
	AIPrompt   string
	Knowledge  string
	Xboard     bool
}

func loadSite(where string, arg any) (*Site, error) {
	s := &Site{}
	var xb int64
	err := db.QueryRow(`SELECT id,name,site_key,domains,color,title,welcome,offline_msg,position,ai_mode,ai_name,ai_prompt,knowledge,xboard FROM sites WHERE `+where, arg).
		Scan(&s.ID, &s.Name, &s.Key, &s.Domains, &s.Color, &s.Title, &s.Welcome, &s.OfflineMsg, &s.Position, &s.AIMode, &s.AIName, &s.AIPrompt, &s.Knowledge, &xb)
	s.Xboard = xb == 1
	return s, err
}

func (s *Site) widgetConfig() M {
	return M{"name": s.Name, "color": s.Color, "title": s.Title, "welcome": s.Welcome, "offline_msg": s.OfflineMsg,
		"position": s.Position, "ai_name": s.AIName, "ai": s.AIMode != "off" && aiConfigured(), "xboard": s.Xboard,
		"community": getSetting("community_enabled", "") == "1", "community_url": communityURL()}
}

// originAllowed checks the page origin against the site's comma separated domain list.
func (s *Site) originAllowed(origin string) bool {
	if strings.TrimSpace(s.Domains) == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, d := range strings.Split(s.Domains, ",") {
		d = strings.ToLower(strings.TrimSpace(d))
		if d != "" && (host == d || strings.HasSuffix(host, "."+d)) {
			return true
		}
	}
	return false
}

func visitorToken(vid string) string {
	m := hmac.New(sha256.New, secretKey)
	m.Write([]byte("v:" + vid))
	return hex.EncodeToString(m.Sum(nil))[:32]
}

func validVisitor(vid, token string) bool {
	return len(vid) >= 16 && len(vid) <= 64 && hmac.Equal([]byte(visitorToken(vid)), []byte(token))
}

type hello struct {
	VID      string          `json:"vid"`
	VToken   string          `json:"vtoken"`
	URL      string          `json:"url"`
	Title    string          `json:"title"`
	Referrer string          `json:"referrer"`
	Lang     string          `json:"lang"`
	User     json.RawMessage `json:"user"`
}

type inbound struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func visitorWS(w http.ResponseWriter, r *http.Request) {
	site, err := loadSite("site_key=?", r.URL.Query().Get("site"))
	if err != nil {
		http.Error(w, "unknown site", 404)
		return
	}
	if !site.originAllowed(r.Header.Get("Origin")) {
		http.Error(w, "origin not allowed", 403)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	ip := clientIP(r)
	ua := r.UserAgent()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	var first inbound
	_, data, err := ws.Read(ctx)
	cancel()
	if err != nil || json.Unmarshal(data, &first) != nil || first.Type != "hello" {
		ws.Close(websocket.StatusPolicyViolation, "hello expected")
		return
	}
	var h hello
	json.Unmarshal(first.Data, &h)
	if !validVisitor(h.VID, h.VToken) {
		h.VID = randToken(12)
	}
	vid := h.VID

	var blocked int64
	db.QueryRow(`SELECT blocked FROM visitors WHERE id=?`, vid).Scan(&blocked)
	if blocked == 1 {
		ws.Close(websocket.StatusPolicyViolation, "blocked")
		return
	}

	lv := upsertVisitor(site, vid, ip, ua, h)
	c := newConn(ws)
	lv, isNew := hub.addVisitor(lv, c)
	if isNew {
		hub.broadcastAgents(event("visitor_online", hub.snapshotOf(vid)))
	}
	recordPage(site.ID, vid, h.URL, h.Title)

	var name, email string
	db.QueryRow(`SELECT name,email FROM visitors WHERE id=?`, vid).Scan(&name, &email)
	c.Send(event("welcome", M{
		"vid": vid, "vtoken": visitorToken(vid), "config": site.widgetConfig(),
		"messages": visitorHistory(vid), "agents_online": hub.anyAgentOnline(),
		"visitor": M{"name": name, "email": email},
	}))

	defer func() {
		hub.removeVisitor(vid, c)
		c.Close()
	}()
	for {
		_, data, err := ws.Read(c.ctx)
		if err != nil {
			return
		}
		var in inbound
		if json.Unmarshal(data, &in) != nil {
			continue
		}
		switch in.Type {
		case "page":
			var p struct{ URL, Title string }
			json.Unmarshal(in.Data, &p)
			recordPage(site.ID, vid, p.URL, p.Title)
		case "typing":
			var t struct{ Text string }
			json.Unmarshal(in.Data, &t)
			lv, _ := hub.getVisitor(vid)
			hub.broadcastAgents(event("visitor_typing", M{"id": vid, "conversation_id": lv.ConversationID, "text": clip(t.Text, 500)}))
		case "msg":
			var m struct {
				Text       string          `json:"text"`
				Attachment json.RawMessage `json:"attachment"`
			}
			json.Unmarshal(in.Data, &m)
			handleVisitorMessage(site, vid, strings.TrimSpace(clip(m.Text, 4000)), sanitizeAttachment(m.Attachment))
		case "profile":
			var p struct{ Name, Email string }
			json.Unmarshal(in.Data, &p)
			db.Exec(`UPDATE visitors SET name=CASE WHEN ?<>'' THEN ? ELSE name END, email=CASE WHEN ?<>'' THEN ? ELSE email END WHERE id=?`,
				clip(p.Name, 64), clip(p.Name, 64), clip(p.Email, 128), clip(p.Email, 128), vid)
			hub.updateVisitor(vid, func(v *LiveVisitor) {
				if p.Name != "" {
					v.Name = clip(p.Name, 64)
				}
				if p.Email != "" {
					v.Email = clip(p.Email, 128)
				}
			})
		case "identify":
			if len(in.Data) > 2 && len(in.Data) < 8192 {
				var xu struct {
					Email string `json:"email"`
				}
				json.Unmarshal(in.Data, &xu)
				db.Exec(`UPDATE visitors SET ext=?, email=CASE WHEN ?<>'' THEN ? ELSE email END WHERE id=?`, string(in.Data), xu.Email, xu.Email, vid)
				hub.updateVisitor(vid, func(v *LiveVisitor) {
					v.Ext = append(json.RawMessage(nil), in.Data...)
					if xu.Email != "" {
						v.Email = xu.Email
					}
				})
			}
		case "rate":
			var p struct{ Rating int }
			json.Unmarshal(in.Data, &p)
			if p.Rating >= 1 && p.Rating <= 5 {
				if cid := latestConversation(vid); cid > 0 {
					db.Exec(`UPDATE conversations SET rating=? WHERE id=?`, p.Rating, cid)
					broadcastConversation(cid)
				}
			}
		}
	}
}

func (h *Hub) snapshotOf(vid string) LiveVisitor {
	v, _ := h.getVisitor(vid)
	return v
}

func upsertVisitor(site *Site, vid, ip, ua string, h hello) *LiveVisitor {
	g := lookupGeo(ip)
	br, osName, dev := parseUA(ua)
	ext := "{}"
	var xu struct {
		Email string `json:"email"`
	}
	if len(h.User) > 2 && len(h.User) < 8192 && json.Valid(h.User) {
		ext = string(h.User)
		json.Unmarshal(h.User, &xu)
	}
	t := now()
	var lastSeen int64
	err := db.QueryRow(`SELECT last_seen FROM visitors WHERE id=?`, vid).Scan(&lastSeen)
	if err == sql.ErrNoRows {
		db.Exec(`INSERT INTO visitors(id,site_id,email,ext,ip,country,region,city,ua,browser,os,device,lang,referrer,first_seen,last_seen)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, vid, site.ID, xu.Email, ext, ip, g.Country, g.Region, g.City, clip(ua, 400),
			br, osName, dev, clip(h.Lang, 32), clip(h.Referrer, 500), t, t)
	} else {
		visitsInc := 0
		if t-lastSeen > 30*60*1000 {
			visitsInc = 1
		}
		db.Exec(`UPDATE visitors SET site_id=?, ip=?, country=?, region=?, city=?, ua=?, browser=?, os=?, device=?, lang=?,
			visits=visits+?, last_seen=?, ext=CASE WHEN ?<>'{}' THEN ? ELSE ext END,
			email=CASE WHEN ?<>'' THEN ? ELSE email END WHERE id=?`,
			site.ID, ip, g.Country, g.Region, g.City, clip(ua, 400), br, osName, dev, clip(h.Lang, 32), visitsInc, t, ext, ext,
			xu.Email, xu.Email, vid)
	}
	lv := &LiveVisitor{VID: vid, SiteID: site.ID, IP: ip, Country: g.Country, Region: g.Region, City: g.City,
		Browser: br, OS: osName, Device: dev, Lang: clip(h.Lang, 32), Referrer: clip(h.Referrer, 500),
		ConnectedAt: t, Ext: json.RawMessage(ext)}
	db.QueryRow(`SELECT name,email,visits FROM visitors WHERE id=?`, vid).Scan(&lv.Name, &lv.Email, &lv.Visits)
	db.QueryRow(`SELECT id FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1`, vid).Scan(&lv.ConversationID)
	lv.Chatting = lv.ConversationID > 0
	return lv
}

func recordPage(siteID int64, vid, u, title string) {
	u, title = clip(u, 1000), clip(title, 300)
	if u == "" {
		return
	}
	var lastURL string
	db.QueryRow(`SELECT url FROM page_views WHERE visitor_id=? ORDER BY id DESC LIMIT 1`, vid).Scan(&lastURL)
	// 每条浏览记录保存当时的 IP 和地区，访问统计按它统计（访客换了网络也能分开算）
	ip, country, region, city := hub.visitorGeo(vid)
	if lastURL != u {
		exec(`INSERT INTO page_views(visitor_id,site_id,url,title,ts,ip,country,region,city) VALUES(?,?,?,?,?,?,?,?,?)`,
			vid, siteID, u, title, now(), ip, country, region, city)
	}
	hub.updateVisitor(vid, func(v *LiveVisitor) {
		if v.URL != u {
			v.Pages++
			v.PageSince = now()
		}
		v.URL, v.Title = u, title
	})
}

func visitorHistory(vid string) []M {
	rs, _ := queryMaps(`SELECT * FROM (SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
		WHERE c.visitor_id=? AND m.sender_type<>'note' ORDER BY m.id DESC LIMIT 60) ORDER BY id`, vid)
	for _, m := range rs {
		decodeAttachment(m)
	}
	return rs
}

func latestConversation(vid string) int64 {
	var id int64
	db.QueryRow(`SELECT id FROM conversations WHERE visitor_id=? ORDER BY id DESC LIMIT 1`, vid).Scan(&id)
	return id
}

// ---- messages ----

var (
	rateMu    sync.Mutex
	rateCount = map[string][]time.Time{}
)

func rateLimited(key string, max int, per time.Duration) bool {
	rateMu.Lock()
	defer rateMu.Unlock()
	cut := time.Now().Add(-per)
	keep := rateCount[key][:0]
	for _, t := range rateCount[key] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= max {
		rateCount[key] = keep
		return true
	}
	rateCount[key] = append(keep, time.Now())
	return false
}

func ensureOpenConversation(siteID int64, vid string) (int64, bool) {
	var id int64
	err := db.QueryRow(`SELECT id FROM conversations WHERE visitor_id=? AND status='open' ORDER BY id DESC LIMIT 1`, vid).Scan(&id)
	if err == nil {
		return id, false
	}
	id, _ = exec(`INSERT INTO conversations(site_id,visitor_id,status,last_at,created_at) VALUES(?,?,'open',?,?)`, siteID, vid, now(), now())
	hub.updateVisitor(vid, func(v *LiveVisitor) { v.ConversationID = id; v.Chatting = true })
	return id, true
}

func insertMessage(convID int64, senderType string, senderID int64, senderName, body, attachment string) M {
	t := now()
	id, _ := exec(`INSERT INTO messages(conversation_id,sender_type,sender_id,sender_name,body,attachment,created_at) VALUES(?,?,?,?,?,?,?)`,
		convID, senderType, senderID, senderName, body, attachment, t)
	if senderType != "note" {
		preview := body
		if preview == "" && attachment != "" {
			preview = "[文件]"
		}
		unreadInc := 0
		if senderType == "visitor" {
			unreadInc = 1
		}
		db.Exec(`UPDATE conversations SET last_msg=?, last_at=?, unread=unread+? WHERE id=?`, clip(preview, 200), t, unreadInc, convID)
	}
	m, _ := queryMap(`SELECT * FROM messages WHERE id=?`, id)
	decodeAttachment(m)
	tgSupportMirror(convID, m)
	return m
}

func decodeAttachment(m M) {
	if s, ok := m["attachment"].(string); ok && s != "" {
		var a any
		json.Unmarshal([]byte(s), &a)
		m["attachment"] = a
	} else {
		m["attachment"] = nil
	}
}

// sanitizeAttachment only accepts attachments that point into our own uploads directory.
func sanitizeAttachment(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var a struct {
		URL  string `json:"url"`
		Name string `json:"name"`
		Size int64  `json:"size"`
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &a) != nil || !strings.HasPrefix(a.URL, "/uploads/") || strings.Contains(a.URL, "..") {
		return ""
	}
	b, _ := json.Marshal(M{"url": a.URL, "name": clip(a.Name, 120), "size": a.Size, "type": clip(a.Type, 80)})
	return string(b)
}

func convRow(id int64) M {
	c, err := queryMap(`SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.country, v.city, v.ext, s.name AS site_name,
		COALESCE(u.name,'') AS assignee_name
		FROM conversations c JOIN visitors v ON v.id=c.visitor_id JOIN sites s ON s.id=c.site_id
		LEFT JOIN users u ON u.id=c.assignee_id WHERE c.id=?`, id)
	if err != nil {
		return nil
	}
	_, c["online"] = hub.getVisitor(c["visitor_id"].(string))
	return c
}

func broadcastConversation(id int64) {
	if c := convRow(id); c != nil {
		hub.broadcastAgents(event("conversation", c))
	}
}

func handleVisitorMessage(site *Site, vid, text, attachment string) {
	if text == "" && attachment == "" {
		return
	}
	if rateLimited("v:"+vid, 20, time.Minute) {
		hub.sendVisitor(vid, event("error", "发送太频繁，请稍后再试"))
		return
	}
	convID, created := ensureOpenConversation(site.ID, vid)
	var name string
	db.QueryRow(`SELECT name FROM visitors WHERE id=?`, vid).Scan(&name)
	msg := insertMessage(convID, "visitor", 0, name, text, attachment)
	hub.sendVisitor(vid, event("message", msg))
	hub.broadcastAgents(event("message", M{"message": msg, "conversation": convRow(convID)}))

	aiWillAnswer := aiShouldReply(site, convID)
	if created && !hub.anyAgentOnline() && !aiWillAnswer && site.OfflineMsg != "" {
		sys := insertMessage(convID, "system", 0, "", site.OfflineMsg, "")
		hub.sendVisitor(vid, event("message", sys))
		hub.broadcastAgents(event("message", M{"message": sys, "conversation": convRow(convID)}))
		hub.sendVisitor(vid, event("ask_contact", true))
	}
	if aiWillAnswer {
		scheduleAIReply(site, convID, vid)
	}
}
