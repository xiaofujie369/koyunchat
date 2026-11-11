package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// Team chat: public channels (everyone), private groups (invite only) and direct messages.

func isMember(channelID, uid int64) bool {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM channel_members WHERE channel_id=? AND user_id=?`, channelID, uid).Scan(&n)
	return n > 0
}

func channelMemberIDs(channelID int64) []int64 {
	rows, err := db.Query(`SELECT user_id FROM channel_members WHERE channel_id=?`, channelID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

func channelFor(uid, id int64) M {
	c, err := queryMap(`SELECT c.*, m.role AS my_role, m.last_read,
		(SELECT COUNT(*) FROM channel_messages x WHERE x.channel_id=c.id AND x.id>m.last_read AND x.user_id<>?) AS unread,
		(SELECT body FROM channel_messages x WHERE x.channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_msg
		FROM channels c JOIN channel_members m ON m.channel_id=c.id AND m.user_id=? WHERE c.id=?`, uid, uid, id)
	if err != nil {
		return nil
	}
	members, _ := queryMaps(`SELECT u.id,u.name,u.avatar,m.role FROM channel_members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=? ORDER BY m.role DESC, u.name`, id)
	for _, x := range members {
		x["online"] = hub.agentOnline(x["id"].(int64))
	}
	c["members"] = members
	if c["kind"] == "dm" {
		for _, x := range members {
			if x["id"].(int64) != uid {
				c["name"] = x["name"]
				c["peer_id"] = x["id"]
			}
		}
	}
	return c
}

func listChannels(w http.ResponseWriter, r *http.Request, u *User) {
	ensureDefaultChannel()
	rows, _ := queryMaps(`SELECT channel_id FROM channel_members WHERE user_id=?`, u.ID)
	out := []M{}
	for _, row := range rows {
		if c := channelFor(u.ID, row["channel_id"].(int64)); c != nil {
			out = append(out, c)
		}
	}
	// public channels the user has left are listed so they can join again
	pub, _ := queryMaps(`SELECT id,name,kind,topic FROM channels WHERE kind='public' AND id NOT IN (SELECT channel_id FROM channel_members WHERE user_id=?)`, u.ID)
	writeJSON(w, M{"channels": out, "joinable": pub})
}

func ensureDefaultChannel() {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM channels WHERE kind='public'`).Scan(&n)
	if n > 0 {
		return
	}
	id, err := exec(`INSERT INTO channels(name,kind,topic,created_at,last_at) VALUES('综合','public','全体成员频道',?,?)`, now(), now())
	if err == nil {
		db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) SELECT ?,id FROM users WHERE disabled=0`, id)
	}
}

func createChannel(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Name    string  `json:"name"`
		Kind    string  `json:"kind"`
		Topic   string  `json:"topic"`
		Members []int64 `json:"members"`
	}
	if readJSON(r, &req) != nil || strings.TrimSpace(req.Name) == "" {
		writeErr(w, 400, "请填写群组名称")
		return
	}
	if req.Kind != "public" {
		req.Kind = "private"
	}
	id, err := exec(`INSERT INTO channels(name,kind,topic,created_by,created_at,last_at) VALUES(?,?,?,?,?,?)`,
		clip(strings.TrimSpace(req.Name), 40), req.Kind, clip(req.Topic, 200), u.ID, now(), now())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	db.Exec(`INSERT INTO channel_members(channel_id,user_id,role) VALUES(?,?,'owner')`, id, u.ID)
	if req.Kind == "public" {
		db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) SELECT ?,id FROM users WHERE disabled=0`, id)
	} else {
		for _, m := range req.Members {
			db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) SELECT ?,id FROM users WHERE id=?`, id, m)
		}
	}
	postSystem(id, u.Name+" 创建了群组")
	notifyChannel(id)
	writeJSON(w, channelFor(u.ID, id))
}

func openDM(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		UserID int64 `json:"user_id"`
	}
	if readJSON(r, &req) != nil || req.UserID == 0 || req.UserID == u.ID {
		writeErr(w, 400, "参数错误")
		return
	}
	a, b := min(u.ID, req.UserID), max(u.ID, req.UserID)
	key := fmt.Sprintf("%d:%d", a, b)
	var id int64
	if db.QueryRow(`SELECT id FROM channels WHERE dm_key=?`, key).Scan(&id) != nil {
		var exists int
		db.QueryRow(`SELECT COUNT(*) FROM users WHERE id=?`, req.UserID).Scan(&exists)
		if exists == 0 {
			writeErr(w, 404, "用户不存在")
			return
		}
		id, _ = exec(`INSERT INTO channels(name,kind,dm_key,created_by,created_at,last_at) VALUES('','dm',?,?,?,?)`, key, u.ID, now(), now())
		db.Exec(`INSERT INTO channel_members(channel_id,user_id) VALUES(?,?),(?,?)`, id, a, id, b)
	}
	writeJSON(w, channelFor(u.ID, id))
}

func getChannel(w http.ResponseWriter, r *http.Request, u *User) {
	c := channelFor(u.ID, pathID(r))
	if c == nil {
		writeErr(w, 404, "群组不存在或你不是成员")
		return
	}
	writeJSON(w, c)
}

func canManage(channelID int64, u *User) bool {
	var role, kind string
	db.QueryRow(`SELECT m.role, c.kind FROM channel_members m JOIN channels c ON c.id=m.channel_id WHERE m.channel_id=? AND m.user_id=?`, channelID, u.ID).Scan(&role, &kind)
	return kind != "dm" && (role == "owner" || u.Role == "admin")
}

func updateChannel(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	if !canManage(id, u) {
		writeErr(w, 403, "只有群主或管理员可以修改")
		return
	}
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	updateFields("channels", id, req, []string{"name", "topic"})
	notifyChannel(id)
	writeJSON(w, channelFor(u.ID, id))
}

func deleteChannel(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	if !canManage(id, u) {
		writeErr(w, 403, "只有群主或管理员可以解散")
		return
	}
	members := channelMemberIDs(id)
	db.Exec(`DELETE FROM channel_messages WHERE channel_id=?`, id)
	db.Exec(`DELETE FROM channel_members WHERE channel_id=?`, id)
	db.Exec(`DELETE FROM channels WHERE id=?`, id)
	hub.sendAgents(members, event("channel_removed", M{"id": id}))
	writeJSON(w, M{"ok": true})
}

func channelMessages(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	if !isMember(id, u.ID) {
		writeErr(w, 403, "你不是该群组成员")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if before == 0 {
		before = 1 << 62
	}
	rs, _ := queryMaps(`SELECT * FROM (SELECT * FROM channel_messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT 80) ORDER BY id`, id, before)
	for _, m := range rs {
		decodeAttachment(m)
	}
	writeJSON(w, rs)
}

func postChannelMessage(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	if !isMember(id, u.ID) {
		writeErr(w, 403, "你不是该群组成员")
		return
	}
	var req struct {
		Body       string          `json:"body"`
		Attachment json.RawMessage `json:"attachment"`
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
	m := insertChannelMessage(id, u.ID, u.Name, body, att)
	db.Exec(`UPDATE channel_members SET last_read=? WHERE channel_id=? AND user_id=?`, m["id"], id, u.ID)
	writeJSON(w, m)
	if aiMentioned(body) {
		go teamAIReply(id, body)
	}
}

func insertChannelMessage(channelID, uid int64, name, body, att string) M {
	t := now()
	mid, _ := exec(`INSERT INTO channel_messages(channel_id,user_id,user_name,body,attachment,created_at) VALUES(?,?,?,?,?,?)`, channelID, uid, name, body, att, t)
	db.Exec(`UPDATE channels SET last_at=? WHERE id=?`, t, channelID)
	m, _ := queryMap(`SELECT * FROM channel_messages WHERE id=?`, mid)
	decodeAttachment(m)
	hub.sendAgents(channelMemberIDs(channelID), event("team_message", m))
	return m
}

func postSystem(channelID int64, text string) {
	insertChannelMessage(channelID, 0, "系统", text, "")
}

func notifyChannel(id int64) {
	hub.sendAgents(channelMemberIDs(id), event("channel_changed", M{"id": id}))
}

func addChannelMembers(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	var kind string
	db.QueryRow(`SELECT kind FROM channels WHERE id=?`, id).Scan(&kind)
	var req struct {
		UserIDs []int64 `json:"user_ids"`
	}
	readJSON(r, &req)
	// joining a public channel yourself needs no membership; inviting into a group needs one
	if kind == "public" && len(req.UserIDs) == 0 {
		db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) VALUES(?,?)`, id, u.ID)
		postSystem(id, u.Name+" 加入了频道")
		notifyChannel(id)
		writeJSON(w, channelFor(u.ID, id))
		return
	}
	if kind == "dm" || kind == "" || !isMember(id, u.ID) {
		writeErr(w, 403, "无权限邀请")
		return
	}
	names := []string{}
	for _, uid := range req.UserIDs {
		var name string
		if db.QueryRow(`SELECT name FROM users WHERE id=? AND disabled=0`, uid).Scan(&name) == nil {
			db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) VALUES(?,?)`, id, uid)
			names = append(names, name)
		}
	}
	if len(names) > 0 {
		postSystem(id, u.Name+" 邀请了 "+strings.Join(names, "、"))
	}
	notifyChannel(id)
	writeJSON(w, channelFor(u.ID, id))
}

func removeChannelMember(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	uid, _ := strconv.ParseInt(r.PathValue("uid"), 10, 64)
	if uid != u.ID && !canManage(id, u) {
		writeErr(w, 403, "无权限移除成员")
		return
	}
	var name string
	db.QueryRow(`SELECT name FROM users WHERE id=?`, uid).Scan(&name)
	db.Exec(`DELETE FROM channel_members WHERE channel_id=? AND user_id=?`, id, uid)
	if uid == u.ID {
		postSystem(id, name+" 退出了群组")
	} else {
		postSystem(id, u.Name+" 将 "+name+" 移出了群组")
	}
	hub.sendAgents([]int64{uid}, event("channel_removed", M{"id": id}))
	notifyChannel(id)
	writeJSON(w, M{"ok": true})
}

func readChannel(w http.ResponseWriter, r *http.Request, u *User) {
	id := pathID(r)
	db.Exec(`UPDATE channel_members SET last_read=(SELECT COALESCE(MAX(id),0) FROM channel_messages WHERE channel_id=?) WHERE channel_id=? AND user_id=?`, id, id, u.ID)
	writeJSON(w, M{"ok": true})
}
