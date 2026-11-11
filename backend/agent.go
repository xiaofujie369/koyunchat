package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

func agentWS(w http.ResponseWriter, r *http.Request) {
	u := userFromToken(r.URL.Query().Get("token"))
	if u == nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	c := newConn(ws)
	if hub.addAgent(u.ID, c) {
		hub.broadcastAgents(event("presence", M{"user_id": u.ID, "online": true}))
		hub.broadcastAgentStatus()
	}
	db.Exec(`UPDATE users SET last_seen=? WHERE id=?`, now(), u.ID)
	defer func() {
		if hub.removeAgent(u.ID, c) {
			db.Exec(`UPDATE users SET last_seen=? WHERE id=?`, now(), u.ID)
			hub.broadcastAgents(event("presence", M{"user_id": u.ID, "online": false}))
			hub.broadcastAgentStatus()
		}
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
		case "typing":
			var t struct {
				ConversationID int64 `json:"conversation_id"`
				Typing         bool  `json:"typing"`
			}
			json.Unmarshal(in.Data, &t)
			var vid string
			db.QueryRow(`SELECT visitor_id FROM conversations WHERE id=?`, t.ConversationID).Scan(&vid)
			if vid != "" {
				hub.sendVisitor(vid, event("agent_typing", M{"name": u.Name, "typing": t.Typing}))
			}
		case "team_typing":
			var t struct {
				ChannelID int64 `json:"channel_id"`
			}
			json.Unmarshal(in.Data, &t)
			if isMember(t.ChannelID, u.ID) {
				hub.sendAgents(channelMemberIDs(t.ChannelID), event("team_typing", M{"channel_id": t.ChannelID, "user_id": u.ID, "name": u.Name}))
			}
		}
	}
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

func bootstrap(w http.ResponseWriter, r *http.Request, u *User) {
	sites, _ := queryMaps(`SELECT id,name,color,site_key,ai_mode FROM sites ORDER BY id`)
	users, _ := queryMaps(`SELECT id,name,email,role,avatar,last_seen FROM users WHERE disabled=0 ORDER BY id`)
	for _, x := range users {
		x["online"] = hub.agentOnline(x["id"].(int64))
	}
	canned, _ := queryMaps(`SELECT id,shortcut,body FROM canned ORDER BY shortcut`)
	writeJSON(w, M{"user": u, "sites": sites, "users": users, "canned": canned, "live": hub.liveVisitors(), "ai": aiConfigured(), "api_url": apiURL,
		"sounds": soundList(), "sound_default": soundDefault(), "plugins": pluginStates()})
}

func stats(w http.ResponseWriter, r *http.Request, u *User) {
	t := time.Now()
	dayStart := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()).UnixMilli()
	var open, unassigned, today, todayMsgs, todayAI int64
	var avgRating float64
	db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE status='open'`).Scan(&open)
	db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE status='open' AND assignee_id=0`).Scan(&unassigned)
	db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE created_at>=?`, dayStart).Scan(&today)
	db.QueryRow(`SELECT COUNT(*) FROM messages WHERE created_at>=?`, dayStart).Scan(&todayMsgs)
	db.QueryRow(`SELECT COUNT(*) FROM messages WHERE created_at>=? AND sender_type='ai'`, dayStart).Scan(&todayAI)
	db.QueryRow(`SELECT COALESCE(AVG(rating),0) FROM conversations WHERE rating>0`).Scan(&avgRating)
	days := []M{}
	for i := 6; i >= 0; i-- {
		d := time.Date(t.Year(), t.Month(), t.Day()-i, 0, 0, 0, 0, t.Location())
		var convs, visitors int64
		db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE created_at>=? AND created_at<?`, d.UnixMilli(), d.AddDate(0, 0, 1).UnixMilli()).Scan(&convs)
		db.QueryRow(`SELECT COUNT(DISTINCT visitor_id) FROM page_views WHERE ts>=? AND ts<?`, d.UnixMilli(), d.AddDate(0, 0, 1).UnixMilli()).Scan(&visitors)
		days = append(days, M{"date": d.Format("01-02"), "conversations": convs, "visitors": visitors})
	}
	writeJSON(w, M{"online_visitors": len(hub.liveVisitors()), "online_agents": len(hub.onlineAgentIDs()), "open": open,
		"unassigned": unassigned, "today_conversations": today, "today_messages": todayMsgs, "today_ai": todayAI,
		"avg_rating": avgRating, "days": days})
}

const convSelect = `SELECT c.*, v.name AS visitor_name, v.email AS visitor_email, v.country, v.city, v.ext, s.name AS site_name,
	COALESCE(u.name,'') AS assignee_name
	FROM conversations c JOIN visitors v ON v.id=c.visitor_id JOIN sites s ON s.id=c.site_id
	LEFT JOIN users u ON u.id=c.assignee_id`

func listConversations(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	where := []string{"1=1"}
	args := []any{}
	switch q.Get("filter") {
	case "mine":
		where = append(where, "c.status='open' AND c.assignee_id=?")
		args = append(args, u.ID)
	case "unassigned":
		where = append(where, "c.status='open' AND c.assignee_id=0")
	case "closed":
		where = append(where, "c.status='closed'")
	case "all":
	default:
		where = append(where, "c.status='open'")
	}
	if s := q.Get("site_id"); s != "" && s != "0" {
		where = append(where, "c.site_id=?")
		args = append(args, s)
	}
	if s := strings.TrimSpace(q.Get("q")); s != "" {
		where = append(where, "(v.name LIKE ? OR v.email LIKE ? OR c.last_msg LIKE ? OR v.ip LIKE ? OR v.ext LIKE ?)")
		like := "%" + s + "%"
		args = append(args, like, like, like, like, like)
	}
	rs, err := queryMaps(convSelect+" WHERE "+strings.Join(where, " AND ")+" ORDER BY c.last_at DESC LIMIT 200", args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	for _, c := range rs {
		_, c["online"] = hub.getVisitor(c["visitor_id"].(string))
	}
	writeJSON(w, rs)
}

func getConversation(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	c := convRow(id)
	if c == nil {
		writeErr(w, 404, "会话不存在")
		return
	}
	msgs, _ := queryMaps(`SELECT * FROM messages WHERE conversation_id=? ORDER BY id`, id)
	for _, m := range msgs {
		decodeAttachment(m)
	}
	writeJSON(w, M{"conversation": c, "messages": msgs, "visitor": visitorDetail(c["visitor_id"].(string))})
}

func visitorDetail(vid string) M {
	v, err := queryMap(`SELECT * FROM visitors WHERE id=?`, vid)
	if err != nil {
		return nil
	}
	pages, _ := queryMaps(`SELECT url,title,ts FROM page_views WHERE visitor_id=? ORDER BY id DESC LIMIT 50`, vid)
	convs, _ := queryMaps(`SELECT id,status,last_msg,last_at,created_at,rating FROM conversations WHERE visitor_id=? ORDER BY id DESC LIMIT 20`, vid)
	v["pages"] = pages
	v["conversations"] = convs
	if live, ok := hub.getVisitor(vid); ok {
		v["live"] = live
	}
	return v
}

func postAgentMessage(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	var req struct {
		Body       string          `json:"body"`
		Attachment json.RawMessage `json:"attachment"`
		Note       bool            `json:"note"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	body := strings.TrimSpace(clip(req.Body, 8000))
	att := sanitizeAttachment(req.Attachment)
	if body == "" && att == "" {
		writeErr(w, 400, "消息为空")
		return
	}
	if req.Note {
		if convRow(id) == nil {
			writeErr(w, 404, "会话不存在")
			return
		}
		m := insertMessage(id, "note", u.ID, u.Name, body, att)
		hub.broadcastAgents(event("message", M{"message": m, "conversation": convRow(id)}))
		writeJSON(w, m)
		return
	}
	m, err := deliverAgentMessage(id, u.ID, u.Name, body, att)
	if err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	writeJSON(w, m)
}

// deliverAgentMessage sends a human agent reply to the visitor (from the console or Telegram).
func deliverAgentMessage(id, senderID int64, senderName, body, att string) (M, error) {
	var vid, status string
	var assignee int64
	if db.QueryRow(`SELECT visitor_id,status,assignee_id FROM conversations WHERE id=?`, id).Scan(&vid, &status, &assignee) != nil {
		return nil, errors.New("会话不存在")
	}
	if status != "open" {
		// reopening: close any other open conversation of the visitor first so there is only one
		db.Exec(`UPDATE conversations SET status='closed', closed_at=? WHERE visitor_id=? AND status='open' AND id<>?`, now(), vid, id)
		db.Exec(`UPDATE conversations SET status='open', closed_at=0 WHERE id=?`, id)
		hub.updateVisitor(vid, func(v *LiveVisitor) { v.ConversationID = id; v.Chatting = true })
	}
	if assignee == 0 && senderID > 0 {
		db.Exec(`UPDATE conversations SET assignee_id=? WHERE id=?`, senderID, id)
	}
	// a human reply takes over from the AI for this conversation
	db.Exec(`UPDATE conversations SET ai_paused=1, unread=0 WHERE id=?`, id)
	cancelAIReply(id)
	m := insertMessage(id, "agent", senderID, senderName, body, att)
	hub.sendVisitor(vid, event("message", m))
	hub.broadcastAgents(event("message", M{"message": m, "conversation": convRow(id)}))
	return m, nil
}

func closeConversation(id int64, byName string) {
	var vid, status string
	if db.QueryRow(`SELECT visitor_id,status FROM conversations WHERE id=?`, id).Scan(&vid, &status) != nil || status == "closed" {
		return
	}
	db.Exec(`UPDATE conversations SET status='closed', closed_at=?, unread=0 WHERE id=?`, now(), id)
	cancelAIReply(id)
	m := insertMessage(id, "system", 0, "", byName+" 结束了会话", "")
	hub.sendVisitor(vid, event("message", m))
	hub.sendVisitor(vid, event("conversation_closed", M{"id": id}))
	hub.updateVisitor(vid, func(v *LiveVisitor) { v.ConversationID = 0; v.Chatting = false })
	broadcastConversation(id)
}

func updateConversation(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	var vid, status string
	if db.QueryRow(`SELECT visitor_id,status FROM conversations WHERE id=?`, id).Scan(&vid, &status) != nil {
		writeErr(w, 404, "会话不存在")
		return
	}
	if s, ok := req["status"].(string); ok && s != status {
		if s == "closed" {
			closeConversation(id, u.Name)
		} else if s == "open" {
			db.Exec(`UPDATE conversations SET status='closed', closed_at=? WHERE visitor_id=? AND status='open' AND id<>?`, now(), vid, id)
			db.Exec(`UPDATE conversations SET status='open', closed_at=0 WHERE id=?`, id)
			hub.updateVisitor(vid, func(v *LiveVisitor) { v.ConversationID = id; v.Chatting = true })
		}
	}
	if a, ok := req["assignee_id"].(float64); ok {
		db.Exec(`UPDATE conversations SET assignee_id=? WHERE id=?`, int64(a), id)
		if int64(a) > 0 && int64(a) != u.ID {
			var name string
			db.QueryRow(`SELECT name FROM users WHERE id=?`, int64(a)).Scan(&name)
			m := insertMessage(id, "note", u.ID, u.Name, u.Name+" 将会话转接给 "+name, "")
			hub.broadcastAgents(event("message", M{"message": m, "conversation": convRow(id)}))
			hub.sendAgents([]int64{int64(a)}, event("assigned", M{"conversation_id": id, "by": u.Name}))
		}
	}
	if p, ok := req["ai_paused"].(bool); ok {
		v := 0
		if p {
			v = 1
			cancelAIReply(id)
		}
		db.Exec(`UPDATE conversations SET ai_paused=? WHERE id=?`, v, id)
	}
	broadcastConversation(id)
	writeJSON(w, convRow(id))
}

func readConversation(w http.ResponseWriter, r *http.Request, u *User) {
	db.Exec(`UPDATE conversations SET unread=0 WHERE id=?`, pathID(r))
	broadcastConversation(pathID(r))
	writeJSON(w, M{"ok": true})
}

func listVisitors(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	if q.Get("live") == "1" {
		writeJSON(w, hub.liveVisitors())
		return
	}
	where, args := "1=1", []any{}
	if s := strings.TrimSpace(q.Get("q")); s != "" {
		like := "%" + s + "%"
		where = "(name LIKE ? OR email LIKE ? OR ip LIKE ? OR ext LIKE ? OR id=?)"
		args = append(args, like, like, like, like, s)
	}
	// 访客记录筛选：最后访问时间、站点、国家、地区、IP（访问统计页点进来时也用）
	if v, _ := strconv.ParseInt(q.Get("from"), 10, 64); v > 0 {
		where += " AND last_seen>=?"
		args = append(args, v)
	}
	if v, _ := strconv.ParseInt(q.Get("to"), 10, 64); v > 0 {
		where += " AND last_seen<?"
		args = append(args, v)
	}
	if v, _ := strconv.ParseInt(q.Get("site"), 10, 64); v > 0 {
		where += " AND site_id=?"
		args = append(args, v)
	}
	if v := q.Get("country"); v != "" {
		if v == "未知" {
			where += " AND country=''"
		} else {
			where += " AND country=?"
			args = append(args, v)
		}
	}
	if v := q.Get("region"); v != "" {
		where += " AND region=?"
		args = append(args, v)
	}
	if v := q.Get("ip"); v != "" {
		where += " AND ip=?"
		args = append(args, v)
	}
	rs, err := queryMaps(`SELECT id,site_id,name,email,ip,country,region,city,browser,os,device,visits,first_seen,last_seen,blocked,ext
		FROM visitors WHERE `+where+` ORDER BY last_seen DESC LIMIT 500`, args...)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, rs)
}

func getVisitor(w http.ResponseWriter, r *http.Request, u *User) {
	v := visitorDetail(r.PathValue("vid"))
	if v == nil {
		writeErr(w, 404, "访客不存在")
		return
	}
	writeJSON(w, v)
}

func updateVisitor(w http.ResponseWriter, r *http.Request, u *User) {
	vid := r.PathValue("vid")
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	sets, args := []string{}, []any{}
	for _, k := range []string{"name", "email", "notes"} {
		if v, ok := req[k].(string); ok {
			sets = append(sets, k+"=?")
			args = append(args, clip(v, 2000))
		}
	}
	if b, ok := req["blocked"].(bool); ok {
		sets = append(sets, "blocked=?")
		if b {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if len(sets) > 0 {
		args = append(args, vid)
		db.Exec(`UPDATE visitors SET `+strings.Join(sets, ",")+` WHERE id=?`, args...)
	}
	if b, _ := req["blocked"].(bool); b {
		hub.mu.RLock()
		var conns []*Conn
		if v, ok := hub.visitors[vid]; ok {
			conns = append(conns, v.conns...)
		}
		hub.mu.RUnlock()
		for _, c := range conns {
			c.Close()
		}
	}
	hub.updateVisitor(vid, func(v *LiveVisitor) {
		if s, ok := req["name"].(string); ok {
			v.Name = s
		}
		if s, ok := req["email"].(string); ok {
			v.Email = s
		}
	})
	writeJSON(w, visitorDetail(vid))
}

// startChat opens (or reuses) a conversation with a live visitor so an agent can message proactively.
func startChat(w http.ResponseWriter, r *http.Request, u *User) {
	vid := r.PathValue("vid")
	var siteID int64
	if db.QueryRow(`SELECT site_id FROM visitors WHERE id=?`, vid).Scan(&siteID) != nil {
		writeErr(w, 404, "访客不存在")
		return
	}
	id, _ := ensureOpenConversation(siteID, vid)
	db.Exec(`UPDATE conversations SET assignee_id=? WHERE id=? AND assignee_id=0`, u.ID, id)
	broadcastConversation(id)
	writeJSON(w, M{"id": id})
}

// ---- sites ----

var siteFields = []string{"name", "domains", "color", "title", "welcome", "offline_msg", "position", "ai_mode", "ai_name", "ai_prompt", "knowledge", "xboard"}

func listSites(w http.ResponseWriter, r *http.Request, u *User) {
	rs, err := queryMaps(`SELECT * FROM sites ORDER BY id`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, rs)
}

func createSite(w http.ResponseWriter, r *http.Request, u *User) {
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	name, _ := req["name"].(string)
	if strings.TrimSpace(name) == "" {
		writeErr(w, 400, "请填写站点名称")
		return
	}
	id, err := exec(`INSERT INTO sites(name,site_key,created_at) VALUES(?,?,?)`, name, randToken(8), now())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	updateFields("sites", id, req, siteFields)
	s, _ := queryMap(`SELECT * FROM sites WHERE id=?`, id)
	writeJSON(w, s)
}

func updateSite(w http.ResponseWriter, r *http.Request, u *User) {
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	if err := updateFields("sites", pathID(r), req, siteFields); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s, _ := queryMap(`SELECT * FROM sites WHERE id=?`, pathID(r))
	writeJSON(w, s)
}

func deleteSite(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	db.Exec(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE site_id=?)`, id)
	db.Exec(`DELETE FROM conversations WHERE site_id=?`, id)
	db.Exec(`DELETE FROM page_views WHERE site_id=?`, id)
	db.Exec(`DELETE FROM visitors WHERE site_id=?`, id)
	db.Exec(`DELETE FROM sites WHERE id=?`, id)
	writeJSON(w, M{"ok": true})
}

// ---- canned replies ----

func listCanned(w http.ResponseWriter, r *http.Request, u *User) {
	rs, _ := queryMaps(`SELECT * FROM canned ORDER BY shortcut`)
	writeJSON(w, rs)
}

func createCanned(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct{ Shortcut, Body string }
	if readJSON(r, &req) != nil || strings.TrimSpace(req.Body) == "" {
		writeErr(w, 400, "请填写内容")
		return
	}
	id, _ := exec(`INSERT INTO canned(shortcut,body,created_at) VALUES(?,?,?)`, strings.TrimSpace(req.Shortcut), req.Body, now())
	writeJSON(w, M{"id": id})
}

func updateCanned(w http.ResponseWriter, r *http.Request, u *User) {
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	updateFields("canned", pathID(r), req, []string{"shortcut", "body"})
	writeJSON(w, M{"ok": true})
}

func deleteCanned(w http.ResponseWriter, r *http.Request, u *User) {
	db.Exec(`DELETE FROM canned WHERE id=?`, pathID(r))
	writeJSON(w, M{"ok": true})
}

// ---- settings ----

var settingKeys = []string{"ai_base_url", "ai_model", "ai_effort", "ai_api_key", "ai_provider", "brand_name", "tg_bot_token", "tg_support_chat_id", "console_url", "sound_default", "pv_retention_days"}

var secretKeys = map[string]string{"ai_api_key": "ai_key_hint", "tg_bot_token": "tg_token_hint"}

func getSettings(w http.ResponseWriter, r *http.Request, u *User) {
	out := M{}
	for _, k := range settingKeys {
		out[k] = getSetting(k, "")
	}
	for key, hint := range secretKeys {
		if k := out[key].(string); k != "" {
			out[key] = ""
			out[hint] = "已设置 (…" + k[max(0, len(k)-4):] + ")"
		}
	}
	out["ai_model_default"] = defaultModel
	writeJSON(w, out)
}

func putSettings(w http.ResponseWriter, r *http.Request, u *User) {
	var req map[string]string
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	for _, k := range settingKeys {
		v, ok := req[k]
		_, secret := secretKeys[k]
		if !ok || (secret && v == "") {
			continue
		}
		if secret && v == "-" {
			v = ""
		}
		setSetting(k, strings.TrimSpace(v))
	}
	resetAIClient()
	if _, ok := req["sound_default"]; ok {
		hub.broadcastAgents(event("sounds", M{"sounds": soundList(), "default": soundDefault()}))
	}
	_, tok := req["tg_bot_token"]
	if tok && req["tg_bot_token"] != "" {
		go tgRestart()
	}
	getSettings(w, r, u)
}
