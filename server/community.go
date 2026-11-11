package main

// Community: customer-facing group chat (TG-like). Customers ("members") sign in with
// their Xboard account (verified server-side against the Xboard API), browse public rooms,
// join private rooms by invite link and chat. Rooms are created by staff only.

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const communitySchema = `
CREATE TABLE IF NOT EXISTS members(
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'xboard',
  ext TEXT NOT NULL DEFAULT '{}',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS member_sessions(
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'public',
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0071e3',
  member_invite INTEGER NOT NULL DEFAULT 1,
  readonly INTEGER NOT NULL DEFAULT 0,
  slow_mode INTEGER NOT NULL DEFAULT 0,
  pinned_id INTEGER NOT NULL DEFAULT 0,
  tg_chat_id TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS room_members(
  room_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  muted_until INTEGER NOT NULL DEFAULT 0,
  last_read INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_rm_member ON room_members(member_id);
CREATE TABLE IF NOT EXISTS room_bans(
  room_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  PRIMARY KEY(room_id, member_id)
);
CREATE TABLE IF NOT EXISTS room_messages(
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id INTEGER NOT NULL DEFAULT 0,
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  reply_to INTEGER NOT NULL DEFAULT 0,
  tg_msg_id INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roommsg ON room_messages(room_id, id);
CREATE TABLE IF NOT EXISTS room_invites(
  code TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
`

func initCommunity() error {
	_, err := db.Exec(communitySchema)
	return err
}

// ---------------- members & auth ----------------

type Member struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Banned bool   `json:"banned"`
}

type memberHandler func(w http.ResponseWriter, r *http.Request, m *Member)

func memberFromToken(token string) *Member {
	if token == "" {
		return nil
	}
	m := &Member{}
	var banned int64
	if db.QueryRow(`SELECT m.id,m.name,m.email,m.banned FROM member_sessions s JOIN members m ON m.id=s.member_id
		WHERE s.token=? AND s.expires_at>?`, token, now()).Scan(&m.ID, &m.Name, &m.Email, &banned) != nil {
		return nil
	}
	m.Banned = banned == 1
	return m
}

func memberAuth(h memberHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m := memberFromToken(bearer(r))
		if m == nil {
			writeErr(w, 401, "请先登录")
			return
		}
		h(w, r, m)
	}
}

var xbClient = &http.Client{Timeout: 10 * time.Second}

func xbRequest(method, u, auth string, body any) (M, error) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, u, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 KoyunChat/1.0")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := xbClient.Do(req)
	if err != nil {
		return nil, errors.New("无法连接账户系统")
	}
	defer resp.Body.Close()
	var out M
	if json.NewDecoder(resp.Body).Decode(&out) != nil {
		return nil, fmt.Errorf("账户系统返回异常 (%d)", resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		if msg, ok := out["message"].(string); ok && msg != "" {
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("账户系统拒绝 (%d)", resp.StatusCode)
	}
	return out, nil
}

// xboardIdentity verifies an Xboard auth token against that Xboard instance and returns the account.
func xboardIdentity(base, authData string) (string, M, error) {
	info, err := xbRequest("GET", base+"/api/v1/user/info", authData, nil)
	if err != nil {
		return "", nil, err
	}
	d, _ := info["data"].(map[string]any)
	email, _ := d["email"].(string)
	if email == "" {
		return "", nil, errors.New("登录已失效，请重新登录")
	}
	if b, _ := d["banned"].(float64); b == 1 {
		return "", nil, errors.New("账户已被封禁")
	}
	ext := M{"email": email}
	if t, ok := d["expired_at"].(float64); ok && t > 0 {
		ext["expired_at"] = time.Unix(int64(t), 0).Format("2006-01-02")
	} else {
		ext["expired_at"] = "长期有效"
	}
	if sub, err := xbRequest("GET", base+"/api/v1/user/getSubscribe", authData, nil); err == nil {
		if sd, ok := sub["data"].(map[string]any); ok {
			if p, ok := sd["plan"].(map[string]any); ok {
				ext["plan"] = p["name"]
			} else {
				ext["plan"] = "无套餐"
			}
		}
	}
	ext["xboard"] = base
	return strings.ToLower(email), ext, nil
}

func upsertMember(email string, ext M) (int64, error) {
	extJSON, _ := json.Marshal(ext)
	var id int64
	err := db.QueryRow(`SELECT id FROM members WHERE email=?`, email).Scan(&id)
	if err == sql.ErrNoRows {
		id, err = exec(`INSERT INTO members(email,ext,created_at,last_seen) VALUES(?,?,?,?)`, email, string(extJSON), now(), now())
		if err != nil {
			return 0, err
		}
		// public nickname never reveals the email
		db.Exec(`UPDATE members SET name=? WHERE id=?`, fmt.Sprintf("用户%04d", id), id)
		return id, nil
	}
	db.Exec(`UPDATE members SET ext=?, last_seen=? WHERE id=?`, string(extJSON), now(), id)
	return id, err
}

func newMemberSession(id int64) string {
	token := randToken(32)
	exec(`INSERT INTO member_sessions(token,member_id,expires_at) VALUES(?,?,?)`, token, id, time.Now().Add(sessionTTL).UnixMilli())
	return token
}

// one-time login codes hand a session from the Xboard page to the community page (another origin)
var (
	codeMu     sync.Mutex
	loginCodes = map[string]struct {
		id  int64
		exp time.Time
	}{}
)

func newLoginCode(id int64) string {
	codeMu.Lock()
	defer codeMu.Unlock()
	for k, v := range loginCodes {
		if time.Now().After(v.exp) {
			delete(loginCodes, k)
		}
	}
	c := randToken(16)
	loginCodes[c] = struct {
		id  int64
		exp time.Time
	}{id, time.Now().Add(2 * time.Minute)}
	return c
}

func communityURL() string {
	if u := getSetting("community_url", ""); u != "" {
		return strings.TrimRight(u, "/") + "/"
	}
	return strings.TrimRight(apiURL, "/") + "/c/"
}

// xboardBaseForOrigin returns the Xboard base URL for a page origin that belongs to an Xboard site.
func xboardBaseForOrigin(origin string) (string, bool) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", false
	}
	rows, _ := queryMaps(`SELECT domains FROM sites WHERE xboard=1 AND domains<>''`)
	for _, r := range rows {
		s := &Site{Domains: r["domains"].(string)}
		if s.originAllowed(origin) {
			return "https://" + u.Host, true
		}
	}
	return "", false
}

func cors(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	}
}

// memberSSO is called by the widget on an Xboard page with the user's Xboard token.
// The token is used once to verify the account and is never stored.
func memberSSO(w http.ResponseWriter, r *http.Request) {
	cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if getSetting("community_enabled", "") != "1" {
		writeErr(w, 403, "社区未开放")
		return
	}
	base, ok := xboardBaseForOrigin(r.Header.Get("Origin"))
	if !ok {
		writeErr(w, 403, "来源站点未授权")
		return
	}
	if rateLimited("sso:"+clientIP(r), 20, 10*time.Minute) {
		writeErr(w, 429, "操作太频繁")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if readJSON(r, &req) != nil || req.Token == "" {
		writeErr(w, 400, "未登录")
		return
	}
	email, ext, err := xboardIdentity(base, req.Token)
	if err != nil {
		writeErr(w, 401, err.Error())
		return
	}
	id, err := upsertMember(email, ext)
	if err != nil {
		writeErr(w, 500, "登录失败")
		return
	}
	writeJSON(w, M{"url": communityURL() + "#/login?code=" + newLoginCode(id)})
}

// memberLogin signs in with Xboard email + password (direct visits to the community page).
func memberLogin(w http.ResponseWriter, r *http.Request) {
	if getSetting("community_enabled", "") != "1" {
		writeErr(w, 403, "社区未开放")
		return
	}
	ip := clientIP(r)
	if loginBlocked("m:" + ip) {
		writeErr(w, 429, "尝试次数过多，请 15 分钟后再试")
		return
	}
	var req struct{ Email, Password string }
	if readJSON(r, &req) != nil || req.Email == "" || req.Password == "" {
		writeErr(w, 400, "请填写邮箱和密码")
		return
	}
	base := strings.TrimRight(getSetting("community_xboard_url", ""), "/")
	if base == "" {
		writeErr(w, 503, "管理员尚未配置账户系统地址")
		return
	}
	res, err := xbRequest("POST", base+"/api/v1/passport/auth/login", "", M{"email": req.Email, "password": req.Password})
	if err != nil {
		loginFailed("m:" + ip)
		writeErr(w, 400, "登录失败："+err.Error())
		return
	}
	d, _ := res["data"].(map[string]any)
	authData, _ := d["auth_data"].(string)
	if authData == "" {
		loginFailed("m:" + ip)
		writeErr(w, 400, "邮箱或密码错误")
		return
	}
	email, ext, err := xboardIdentity(base, authData)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	id, err := upsertMember(email, ext)
	if err != nil {
		writeErr(w, 500, "登录失败")
		return
	}
	writeJSON(w, M{"token": newMemberSession(id), "member": memberProfile(id)})
}

func memberExchange(w http.ResponseWriter, r *http.Request) {
	var req struct{ Code string }
	readJSON(r, &req)
	codeMu.Lock()
	c, ok := loginCodes[req.Code]
	delete(loginCodes, req.Code)
	codeMu.Unlock()
	if !ok || time.Now().After(c.exp) {
		writeErr(w, 400, "登录链接已失效，请重新进入")
		return
	}
	writeJSON(w, M{"token": newMemberSession(c.id), "member": memberProfile(c.id)})
}

func memberProfile(id int64) M {
	m, _ := queryMap(`SELECT id,name,banned FROM members WHERE id=?`, id)
	return m
}

func memberMe(w http.ResponseWriter, r *http.Request, m *Member) {
	writeJSON(w, M{"member": memberProfile(m.ID), "name": getSetting("brand_name", "Koyun 社区")})
}

func memberUpdate(w http.ResponseWriter, r *http.Request, m *Member) {
	var req struct{ Name string }
	readJSON(r, &req)
	name := strings.TrimSpace(clip(req.Name, 20))
	if len([]rune(name)) < 2 {
		writeErr(w, 400, "昵称 2–20 个字")
		return
	}
	if strings.Contains(name, "客服") || strings.Contains(strings.ToLower(name), "admin") || strings.Contains(name, "官方") {
		writeErr(w, 400, "昵称不能包含“客服”“官方”等字样")
		return
	}
	db.Exec(`UPDATE members SET name=? WHERE id=?`, name, m.ID)
	writeJSON(w, memberProfile(m.ID))
}

func memberLogout(w http.ResponseWriter, r *http.Request, m *Member) {
	db.Exec(`DELETE FROM member_sessions WHERE token=?`, bearer(r))
	writeJSON(w, M{"ok": true})
}

// ---------------- rooms ----------------

type Room struct {
	ID           int64
	Name         string
	Kind         string
	MemberInvite bool
	Readonly     bool
	SlowMode     int64
	TGChatID     string
}

func loadRoom(id int64) (*Room, error) {
	r := &Room{}
	var mi, ro int64
	err := db.QueryRow(`SELECT id,name,kind,member_invite,readonly,slow_mode,tg_chat_id FROM rooms WHERE id=?`, id).
		Scan(&r.ID, &r.Name, &r.Kind, &mi, &ro, &r.SlowMode, &r.TGChatID)
	r.MemberInvite, r.Readonly = mi == 1, ro == 1
	return r, err
}

func isRoomMember(roomID, memberID int64) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM room_members WHERE room_id=? AND member_id=?`, roomID, memberID).Scan(&n)
	return n > 0
}

func roomBanned(roomID, memberID int64) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM room_bans WHERE room_id=? AND member_id=?`, roomID, memberID).Scan(&n)
	return n > 0
}

const roomCols = `r.id,r.name,r.kind,r.description,r.color,r.member_invite,r.readonly,r.slow_mode,r.pinned_id,r.last_at,
	(SELECT COUNT(*) FROM room_members x WHERE x.room_id=r.id) AS member_count`

func withPinned(rooms []M) {
	for _, r := range rooms {
		if pid, _ := r["pinned_id"].(int64); pid > 0 {
			r["pinned"] = roomMessage(pid)
		}
	}
}

func memberRooms(w http.ResponseWriter, r *http.Request, m *Member) {
	joined, _ := queryMaps(`SELECT `+roomCols+`, rm.muted_until,
		(SELECT COUNT(*) FROM room_messages x WHERE x.room_id=r.id AND x.id>rm.last_read AND x.deleted=0 AND NOT (x.sender_kind='member' AND x.sender_id=?)) AS unread,
		(SELECT CASE WHEN deleted=1 THEN '消息已删除' WHEN body='' THEN '[文件]' ELSE sender_name||': '||substr(body,1,60) END FROM room_messages x WHERE x.room_id=r.id ORDER BY id DESC LIMIT 1) AS last_msg
		FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.member_id=? ORDER BY r.sort DESC, r.last_at DESC`, m.ID, m.ID)
	public, _ := queryMaps(`SELECT `+roomCols+` FROM rooms r WHERE r.kind='public'
		AND r.id NOT IN (SELECT room_id FROM room_members WHERE member_id=?) ORDER BY r.sort DESC, r.id`, m.ID)
	withPinned(joined)
	writeJSON(w, M{"joined": joined, "public": public})
}

func memberJoin(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil || room.Kind != "public" {
		writeErr(w, 403, "这是私密群组，需要邀请链接才能加入")
		return
	}
	if msg := joinRoom(room, m); msg != "" {
		writeErr(w, 403, msg)
		return
	}
	writeJSON(w, M{"ok": true, "room_id": room.ID})
}

func joinRoom(room *Room, m *Member) string {
	if m.Banned {
		return "你的账号已被禁止参与社区"
	}
	if roomBanned(room.ID, m.ID) {
		return "你已被移出该群组，无法再次加入"
	}
	if isRoomMember(room.ID, m.ID) {
		return ""
	}
	db.Exec(`INSERT OR IGNORE INTO room_members(room_id,member_id,joined_at) VALUES(?,?,?)`, room.ID, m.ID, now())
	insertRoomMessage(room, "system", 0, "", m.Name+" 加入了群组", "", 0)
	return ""
}

func memberLeave(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil {
		writeErr(w, 404, "群组不存在")
		return
	}
	db.Exec(`DELETE FROM room_members WHERE room_id=? AND member_id=?`, room.ID, m.ID)
	insertRoomMessage(room, "system", 0, "", m.Name+" 退出了群组", "", 0)
	writeJSON(w, M{"ok": true})
}

func createInvite(roomID int64, by string) M {
	code := randToken(6)
	exp := time.Now().Add(7 * 24 * time.Hour).UnixMilli()
	exec(`INSERT INTO room_invites(code,room_id,created_by,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?)`, code, roomID, by, 50, exp, now())
	return M{"code": code, "url": communityURL() + "#/join/" + code, "expires_at": exp, "max_uses": 50}
}

func memberInvite(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil || !isRoomMember(room.ID, m.ID) {
		writeErr(w, 403, "你不在该群组")
		return
	}
	if room.Kind != "public" && !room.MemberInvite {
		writeErr(w, 403, "该群组只允许管理员邀请")
		return
	}
	if rateLimited("inv:"+strconv.FormatInt(m.ID, 10), 10, time.Hour) {
		writeErr(w, 429, "生成邀请太频繁")
		return
	}
	writeJSON(w, createInvite(room.ID, "member:"+strconv.FormatInt(m.ID, 10)))
}

func inviteLookup(code string) (*Room, string) {
	var roomID, uses, maxUses, exp int64
	if db.QueryRow(`SELECT room_id,uses,max_uses,expires_at FROM room_invites WHERE code=?`, code).Scan(&roomID, &uses, &maxUses, &exp) != nil {
		return nil, "邀请链接无效"
	}
	if exp > 0 && exp < now() {
		return nil, "邀请链接已过期"
	}
	if maxUses > 0 && uses >= maxUses {
		return nil, "邀请链接已达到使用上限"
	}
	room, err := loadRoom(roomID)
	if err != nil {
		return nil, "群组已不存在"
	}
	return room, ""
}

func memberInvitePreview(w http.ResponseWriter, r *http.Request, m *Member) {
	room, msg := inviteLookup(r.PathValue("code"))
	if room == nil {
		writeErr(w, 404, msg)
		return
	}
	info, _ := queryMap(`SELECT `+roomCols+` FROM rooms r WHERE r.id=?`, room.ID)
	info["joined"] = isRoomMember(room.ID, m.ID)
	writeJSON(w, info)
}

func memberInviteAccept(w http.ResponseWriter, r *http.Request, m *Member) {
	code := r.PathValue("code")
	room, msg := inviteLookup(code)
	if room == nil {
		writeErr(w, 404, msg)
		return
	}
	if !isRoomMember(room.ID, m.ID) {
		if msg := joinRoom(room, m); msg != "" {
			writeErr(w, 403, msg)
			return
		}
		db.Exec(`UPDATE room_invites SET uses=uses+1 WHERE code=?`, code)
	}
	writeJSON(w, M{"ok": true, "room_id": room.ID})
}

// ---------------- messages ----------------

func roomMessage(id int64) M {
	m, err := queryMap(`SELECT id,room_id,sender_kind,sender_id,sender_name,body,attachment,reply_to,deleted,created_at FROM room_messages WHERE id=?`, id)
	if err != nil {
		return nil
	}
	finishRoomMessage(m)
	return m
}

func finishRoomMessage(m M) {
	if d, _ := m["deleted"].(int64); d == 1 {
		m["body"], m["attachment"] = "", nil
	} else {
		decodeAttachment(m)
	}
	if rid, _ := m["reply_to"].(int64); rid > 0 {
		if q, err := queryMap(`SELECT id,sender_name,body,deleted,attachment FROM room_messages WHERE id=?`, rid); err == nil {
			if d, _ := q["deleted"].(int64); d == 1 {
				q["body"] = "消息已删除"
			} else if q["body"] == "" && q["attachment"] != "" {
				q["body"] = "[文件]"
			}
			q["body"] = clip(fmt.Sprint(q["body"]), 80)
			delete(q, "attachment")
			m["reply"] = q
		}
	}
}

func listRoomMessages(roomID, before int64) []M {
	if before == 0 {
		before = 1 << 62
	}
	rs, _ := queryMaps(`SELECT * FROM (SELECT id,room_id,sender_kind,sender_id,sender_name,body,attachment,reply_to,deleted,created_at
		FROM room_messages WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 60) ORDER BY id`, roomID, before)
	for _, m := range rs {
		finishRoomMessage(m)
	}
	return rs
}

func insertRoomMessage(room *Room, kind string, senderID int64, name, body, att string, replyTo int64) M {
	t := now()
	id, _ := exec(`INSERT INTO room_messages(room_id,sender_kind,sender_id,sender_name,body,attachment,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		room.ID, kind, senderID, name, body, att, replyTo, t)
	db.Exec(`UPDATE rooms SET last_at=? WHERE id=?`, t, room.ID)
	m := roomMessage(id)
	broadcastRoom(room.ID, event("room_message", m))
	if kind != "tg" && kind != "system" {
		tgForward(room, m)
	}
	return m
}

func memberMessages(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil {
		writeErr(w, 404, "群组不存在")
		return
	}
	if room.Kind != "public" && !isRoomMember(room.ID, m.ID) {
		writeErr(w, 403, "你不在该群组")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	writeJSON(w, listRoomMessages(room.ID, before))
}

func memberPost(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil || !isRoomMember(room.ID, m.ID) {
		writeErr(w, 403, "请先加入群组")
		return
	}
	if m.Banned {
		writeErr(w, 403, "你的账号已被禁止发言")
		return
	}
	if room.Readonly {
		writeErr(w, 403, "该群组仅管理员可以发言")
		return
	}
	var mutedUntil int64
	db.QueryRow(`SELECT muted_until FROM room_members WHERE room_id=? AND member_id=?`, room.ID, m.ID).Scan(&mutedUntil)
	if mutedUntil > now() {
		writeErr(w, 403, "你已被禁言至 "+time.UnixMilli(mutedUntil).Format("01-02 15:04"))
		return
	}
	var req struct {
		Body       string          `json:"body"`
		Attachment json.RawMessage `json:"attachment"`
		ReplyTo    int64           `json:"reply_to"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	body := strings.TrimSpace(clip(req.Body, 2000))
	att := sanitizeAttachment(req.Attachment)
	if body == "" && att == "" {
		writeErr(w, 400, "消息为空")
		return
	}
	key := "rm:" + strconv.FormatInt(m.ID, 10)
	if rateLimited(key, 8, 10*time.Second) {
		writeErr(w, 429, "发言太快了，休息一下")
		return
	}
	if room.SlowMode > 0 {
		var last int64
		db.QueryRow(`SELECT COALESCE(MAX(created_at),0) FROM room_messages WHERE room_id=? AND sender_kind='member' AND sender_id=?`, room.ID, m.ID).Scan(&last)
		if wait := last + room.SlowMode*1000 - now(); wait > 0 {
			writeErr(w, 429, fmt.Sprintf("慢速模式：%d 秒后才能再发言", wait/1000+1))
			return
		}
	}
	if req.ReplyTo > 0 {
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM room_messages WHERE id=? AND room_id=?`, req.ReplyTo, room.ID).Scan(&n)
		if n == 0 {
			req.ReplyTo = 0
		}
	}
	msg := insertRoomMessage(room, "member", m.ID, m.Name, body, att, req.ReplyTo)
	db.Exec(`UPDATE room_members SET last_read=? WHERE room_id=? AND member_id=?`, msg["id"], room.ID, m.ID)
	writeJSON(w, msg)
}

func memberDeleteMessage(w http.ResponseWriter, r *http.Request, m *Member) {
	id := pathID(r)
	var roomID, senderID int64
	var kind string
	if db.QueryRow(`SELECT room_id,sender_kind,sender_id FROM room_messages WHERE id=?`, id).Scan(&roomID, &kind, &senderID) != nil || kind != "member" || senderID != m.ID {
		writeErr(w, 403, "只能删除自己的消息")
		return
	}
	deleteRoomMessage(roomID, id)
	writeJSON(w, M{"ok": true})
}

func deleteRoomMessage(roomID, id int64) {
	db.Exec(`UPDATE room_messages SET deleted=1 WHERE id=?`, id)
	broadcastRoom(roomID, event("room_message_deleted", M{"room_id": roomID, "id": id}))
	tgDelete(roomID, id)
}

func memberRead(w http.ResponseWriter, r *http.Request, m *Member) {
	id := pathID(r)
	db.Exec(`UPDATE room_members SET last_read=(SELECT COALESCE(MAX(id),0) FROM room_messages WHERE room_id=?) WHERE room_id=? AND member_id=?`, id, id, m.ID)
	writeJSON(w, M{"ok": true})
}

func memberRoomMembers(w http.ResponseWriter, r *http.Request, m *Member) {
	room, err := loadRoom(pathID(r))
	if err != nil || (room.Kind != "public" && !isRoomMember(room.ID, m.ID)) {
		writeErr(w, 403, "你不在该群组")
		return
	}
	rs, _ := queryMaps(`SELECT m.id,m.name FROM room_members rm JOIN members m ON m.id=rm.member_id WHERE rm.room_id=? ORDER BY rm.joined_at LIMIT 300`, room.ID)
	for _, x := range rs {
		x["online"] = mhub.online(x["id"].(int64))
	}
	writeJSON(w, rs)
}

func memberUpload(w http.ResponseWriter, r *http.Request, m *Member) {
	if m.Banned || rateLimited("mup:"+strconv.FormatInt(m.ID, 10), 20, 10*time.Minute) {
		writeErr(w, 429, "上传太频繁")
		return
	}
	a, msg := saveUpload(w, r)
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	writeJSON(w, a)
}

// ---------------- realtime ----------------

type memberHub struct {
	mu    sync.RWMutex
	conns map[int64][]*Conn
}

var mhub = &memberHub{conns: map[int64][]*Conn{}}

func (h *memberHub) online(id int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns[id]) > 0
}

func broadcastRoom(roomID int64, b []byte) {
	ids := map[int64]bool{}
	if rows, err := db.Query(`SELECT member_id FROM room_members WHERE room_id=?`, roomID); err == nil {
		for rows.Next() {
			var id int64
			rows.Scan(&id)
			ids[id] = true
		}
		rows.Close()
	}
	mhub.mu.RLock()
	var conns []*Conn
	for id, cs := range mhub.conns {
		if ids[id] {
			conns = append(conns, cs...)
		}
	}
	mhub.mu.RUnlock()
	for _, c := range conns {
		c.Send(b)
	}
	hub.broadcastAgents(b) // staff watch every room from the console
}

func sendMember(id int64, b []byte) {
	mhub.mu.RLock()
	cs := append([]*Conn(nil), mhub.conns[id]...)
	mhub.mu.RUnlock()
	for _, c := range cs {
		c.Send(b)
	}
}

func memberWS(w http.ResponseWriter, r *http.Request) {
	m := memberFromToken(r.URL.Query().Get("token"))
	if m == nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(8 << 10)
	c := newConn(ws)
	mhub.mu.Lock()
	mhub.conns[m.ID] = append(mhub.conns[m.ID], c)
	mhub.mu.Unlock()
	db.Exec(`UPDATE members SET last_seen=? WHERE id=?`, now(), m.ID)
	defer func() {
		mhub.mu.Lock()
		cs := mhub.conns[m.ID]
		for i, x := range cs {
			if x == c {
				cs = append(cs[:i], cs[i+1:]...)
				break
			}
		}
		if len(cs) == 0 {
			delete(mhub.conns, m.ID)
		} else {
			mhub.conns[m.ID] = cs
		}
		mhub.mu.Unlock()
		db.Exec(`UPDATE members SET last_seen=? WHERE id=?`, now(), m.ID)
		c.Close()
	}()
	for {
		if _, _, err := ws.Read(c.ctx); err != nil {
			return
		}
	}
}

// ---------------- staff side ----------------

var roomFields = []string{"name", "kind", "description", "color", "member_invite", "readonly", "slow_mode", "sort", "tg_chat_id"}

func staffRooms(w http.ResponseWriter, r *http.Request, u *User) {
	rs, _ := queryMaps(`SELECT ` + roomCols + `, r.tg_chat_id, r.sort,
		(SELECT CASE WHEN deleted=1 THEN '消息已删除' WHEN body='' THEN '[文件]' ELSE sender_name||': '||substr(body,1,60) END FROM room_messages x WHERE x.room_id=r.id ORDER BY id DESC LIMIT 1) AS last_msg
		FROM rooms r ORDER BY r.sort DESC, r.last_at DESC`)
	withPinned(rs)
	writeJSON(w, M{"rooms": rs, "enabled": getSetting("community_enabled", "") == "1", "url": communityURL(),
		"xboard_url": getSetting("community_xboard_url", ""), "tg": tgStatus()})
}

func staffCreateRoom(w http.ResponseWriter, r *http.Request, u *User) {
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	name, _ := req["name"].(string)
	if strings.TrimSpace(name) == "" {
		writeErr(w, 400, "请填写群组名称")
		return
	}
	id, err := exec(`INSERT INTO rooms(name,created_at,last_at) VALUES(?,?,?)`, name, now(), now())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	updateFields("rooms", id, req, roomFields)
	tgRefreshBindings()
	writeJSON(w, M{"id": id})
}

func staffUpdateRoom(w http.ResponseWriter, r *http.Request, u *User) {
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	id := pathID(r)
	if err := updateFields("rooms", id, req, roomFields); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	tgRefreshBindings()
	broadcastRoom(id, event("room_updated", M{"id": id}))
	writeJSON(w, M{"ok": true})
}

func staffDeleteRoom(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	broadcastRoom(id, event("room_removed", M{"id": id}))
	for _, t := range []string{"room_messages", "room_members", "room_bans", "room_invites"} {
		db.Exec(`DELETE FROM `+t+` WHERE room_id=?`, id)
	}
	db.Exec(`DELETE FROM rooms WHERE id=?`, id)
	tgRefreshBindings()
	writeJSON(w, M{"ok": true})
}

func staffRoomMessages(w http.ResponseWriter, r *http.Request, u *User) {
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	writeJSON(w, listRoomMessages(pathID(r), before))
}

func staffPost(w http.ResponseWriter, r *http.Request, u *User) {
	room, err := loadRoom(pathID(r))
	if err != nil {
		writeErr(w, 404, "群组不存在")
		return
	}
	var req struct {
		Body       string          `json:"body"`
		Attachment json.RawMessage `json:"attachment"`
		ReplyTo    int64           `json:"reply_to"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	body := strings.TrimSpace(clip(req.Body, 4000))
	att := sanitizeAttachment(req.Attachment)
	if body == "" && att == "" {
		writeErr(w, 400, "消息为空")
		return
	}
	writeJSON(w, insertRoomMessage(room, "staff", u.ID, u.Name, body, att, req.ReplyTo))
}

func staffDeleteMessage(w http.ResponseWriter, r *http.Request, u *User) {
	var roomID int64
	if db.QueryRow(`SELECT room_id FROM room_messages WHERE id=?`, pathID(r)).Scan(&roomID) != nil {
		writeErr(w, 404, "消息不存在")
		return
	}
	deleteRoomMessage(roomID, pathID(r))
	writeJSON(w, M{"ok": true})
}

func staffPin(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		MessageID int64 `json:"message_id"`
	}
	readJSON(r, &req)
	id := pathID(r)
	db.Exec(`UPDATE rooms SET pinned_id=? WHERE id=?`, req.MessageID, id)
	broadcastRoom(id, event("room_updated", M{"id": id}))
	writeJSON(w, M{"ok": true})
}

func staffRoomMembers(w http.ResponseWriter, r *http.Request, u *User) {
	rs, _ := queryMaps(`SELECT m.id,m.name,m.email,m.ext,m.banned,rm.muted_until,rm.joined_at FROM room_members rm JOIN members m ON m.id=rm.member_id
		WHERE rm.room_id=? ORDER BY rm.joined_at DESC LIMIT 500`, pathID(r))
	for _, x := range rs {
		x["online"] = mhub.online(x["id"].(int64))
	}
	writeJSON(w, rs)
}

// staffModerate: action = mute (minutes, 0 = unmute) | kick | ban (kick + block rejoin) | unban
func staffModerate(w http.ResponseWriter, r *http.Request, u *User) {
	room, err := loadRoom(pathID(r))
	if err != nil {
		writeErr(w, 404, "群组不存在")
		return
	}
	var req struct {
		MemberID int64  `json:"member_id"`
		Action   string `json:"action"`
		Minutes  int64  `json:"minutes"`
	}
	readJSON(r, &req)
	var name string
	if db.QueryRow(`SELECT name FROM members WHERE id=?`, req.MemberID).Scan(&name) != nil {
		writeErr(w, 404, "成员不存在")
		return
	}
	switch req.Action {
	case "mute":
		until := int64(0)
		if req.Minutes > 0 {
			until = now() + req.Minutes*60*1000
			insertRoomMessage(room, "system", 0, "", fmt.Sprintf("%s 被禁言 %s", name, fmtMinutes(req.Minutes)), "", 0)
		}
		db.Exec(`UPDATE room_members SET muted_until=? WHERE room_id=? AND member_id=?`, until, room.ID, req.MemberID)
	case "kick", "ban":
		db.Exec(`DELETE FROM room_members WHERE room_id=? AND member_id=?`, room.ID, req.MemberID)
		if req.Action == "ban" {
			db.Exec(`INSERT OR IGNORE INTO room_bans(room_id,member_id) VALUES(?,?)`, room.ID, req.MemberID)
		}
		sendMember(req.MemberID, event("room_removed", M{"id": room.ID}))
		insertRoomMessage(room, "system", 0, "", name+" 被移出群组", "", 0)
	case "unban":
		db.Exec(`DELETE FROM room_bans WHERE room_id=? AND member_id=?`, room.ID, req.MemberID)
	default:
		writeErr(w, 400, "未知操作")
		return
	}
	writeJSON(w, M{"ok": true})
}

func fmtMinutes(m int64) string {
	switch {
	case m >= 1440:
		return fmt.Sprintf("%d 天", m/1440)
	case m >= 60:
		return fmt.Sprintf("%d 小时", m/60)
	}
	return fmt.Sprintf("%d 分钟", m)
}

func staffBanMember(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Banned bool `json:"banned"`
	}
	readJSON(r, &req)
	v := 0
	if req.Banned {
		v = 1
		db.Exec(`DELETE FROM member_sessions WHERE member_id=?`, pathID(r))
	}
	db.Exec(`UPDATE members SET banned=? WHERE id=?`, v, pathID(r))
	writeJSON(w, M{"ok": true})
}

func staffInvite(w http.ResponseWriter, r *http.Request, u *User) {
	if _, err := loadRoom(pathID(r)); err != nil {
		writeErr(w, 404, "群组不存在")
		return
	}
	writeJSON(w, createInvite(pathID(r), "staff:"+strconv.FormatInt(u.ID, 10)))
}

func staffCommunitySettings(w http.ResponseWriter, r *http.Request, u *User) {
	var req map[string]string
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	for _, k := range []string{"community_enabled", "community_xboard_url", "community_url", "brand_name"} {
		if v, ok := req[k]; ok {
			setSetting(k, strings.TrimSpace(v))
		}
	}
	writeJSON(w, M{"ok": true})
}

func registerCommunityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/m/sso", memberSSO)
	mux.HandleFunc("OPTIONS /api/m/sso", memberSSO)
	mux.HandleFunc("POST /api/m/login", memberLogin)
	mux.HandleFunc("POST /api/m/exchange", memberExchange)
	mux.HandleFunc("GET /api/m/me", memberAuth(memberMe))
	mux.HandleFunc("PUT /api/m/me", memberAuth(memberUpdate))
	mux.HandleFunc("POST /api/m/logout", memberAuth(memberLogout))
	mux.HandleFunc("GET /api/m/rooms", memberAuth(memberRooms))
	mux.HandleFunc("POST /api/m/rooms/{id}/join", memberAuth(memberJoin))
	mux.HandleFunc("POST /api/m/rooms/{id}/leave", memberAuth(memberLeave))
	mux.HandleFunc("POST /api/m/rooms/{id}/invite", memberAuth(memberInvite))
	mux.HandleFunc("GET /api/m/rooms/{id}/messages", memberAuth(memberMessages))
	mux.HandleFunc("POST /api/m/rooms/{id}/messages", memberAuth(memberPost))
	mux.HandleFunc("POST /api/m/rooms/{id}/read", memberAuth(memberRead))
	mux.HandleFunc("GET /api/m/rooms/{id}/members", memberAuth(memberRoomMembers))
	mux.HandleFunc("DELETE /api/m/messages/{id}", memberAuth(memberDeleteMessage))
	mux.HandleFunc("GET /api/m/invites/{code}", memberAuth(memberInvitePreview))
	mux.HandleFunc("POST /api/m/invites/{code}", memberAuth(memberInviteAccept))
	mux.HandleFunc("POST /api/m/upload", memberAuth(memberUpload))
	mux.HandleFunc("GET /ws/member", memberWS)

	mux.HandleFunc("GET /api/community/rooms", auth(staffRooms))
	mux.HandleFunc("POST /api/community/rooms", admin(staffCreateRoom))
	mux.HandleFunc("PUT /api/community/rooms/{id}", admin(staffUpdateRoom))
	mux.HandleFunc("DELETE /api/community/rooms/{id}", admin(staffDeleteRoom))
	mux.HandleFunc("GET /api/community/rooms/{id}/messages", auth(staffRoomMessages))
	mux.HandleFunc("POST /api/community/rooms/{id}/messages", auth(staffPost))
	mux.HandleFunc("POST /api/community/rooms/{id}/pin", auth(staffPin))
	mux.HandleFunc("GET /api/community/rooms/{id}/members", auth(staffRoomMembers))
	mux.HandleFunc("POST /api/community/rooms/{id}/moderate", auth(staffModerate))
	mux.HandleFunc("POST /api/community/rooms/{id}/invite", auth(staffInvite))
	mux.HandleFunc("DELETE /api/community/messages/{id}", auth(staffDeleteMessage))
	mux.HandleFunc("POST /api/community/members/{id}/ban", auth(staffBanMember))
	mux.HandleFunc("PUT /api/community/settings", admin(staffCommunitySettings))
	mux.HandleFunc("GET /c/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		p := strings.TrimPrefix(r.URL.Path, "/c/")
		if p == "" || p == "index.html" {
			serveIndex(w, "c/index.html")
			return
		}
		http.ServeFileFS(w, r, webSub(), "c/"+p)
	})
}
