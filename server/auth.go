package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID     int64  `json:"id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Avatar string `json:"avatar"`
}

type authedHandler func(w http.ResponseWriter, r *http.Request, u *User)

const sessionTTL = 30 * 24 * time.Hour

func userFromToken(token string) *User {
	if token == "" {
		return nil
	}
	u := &User{}
	err := db.QueryRow(`SELECT u.id,u.email,u.name,u.role,u.avatar FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.token=? AND s.expires_at>? AND u.disabled=0`, token, now()).Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.Avatar)
	if err != nil {
		return nil
	}
	return u
}

func bearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

func auth(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromToken(bearer(r))
		if u == nil {
			writeErr(w, 401, "未登录或登录已过期")
			return
		}
		h(w, r, u)
	}
}

func admin(h authedHandler) http.HandlerFunc {
	return auth(func(w http.ResponseWriter, r *http.Request, u *User) {
		if u.Role != "admin" {
			writeErr(w, 403, "需要管理员权限")
			return
		}
		h(w, r, u)
	})
}

// simple per-IP login throttle
var (
	loginMu       sync.Mutex
	loginFailures = map[string][]time.Time{}
)

func loginBlocked(ip string) bool {
	loginMu.Lock()
	defer loginMu.Unlock()
	cut := time.Now().Add(-15 * time.Minute)
	keep := loginFailures[ip][:0]
	for _, t := range loginFailures[ip] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	loginFailures[ip] = keep
	return len(keep) >= 10
}

func loginFailed(ip string) {
	loginMu.Lock()
	loginFailures[ip] = append(loginFailures[ip], time.Now())
	loginMu.Unlock()
}

func login(w http.ResponseWriter, r *http.Request) {
	var req struct{ Email, Password string }
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	ip := clientIP(r)
	if loginBlocked(ip) {
		writeErr(w, 429, "尝试次数过多，请 15 分钟后再试")
		return
	}
	var id int64
	var hash string
	err := db.QueryRow(`SELECT id,password FROM users WHERE email=? AND disabled=0`, strings.TrimSpace(strings.ToLower(req.Email))).Scan(&id, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		loginFailed(ip)
		writeErr(w, 400, "邮箱或密码错误")
		return
	}
	token := randToken(32)
	exec(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)`, token, id, time.Now().Add(sessionTTL).UnixMilli())
	writeJSON(w, M{"token": token, "user": userFromToken(token)})
}

func logout(w http.ResponseWriter, r *http.Request, u *User) {
	db.Exec(`DELETE FROM sessions WHERE token=?`, bearer(r))
	writeJSON(w, M{"ok": true})
}

func me(w http.ResponseWriter, r *http.Request, u *User) { writeJSON(w, u) }

func updateMe(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct{ Name, Avatar, OldPassword, NewPassword string }
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	if req.NewPassword != "" {
		var hash string
		db.QueryRow(`SELECT password FROM users WHERE id=?`, u.ID).Scan(&hash)
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.OldPassword)) != nil {
			writeErr(w, 400, "原密码错误")
			return
		}
		if len(req.NewPassword) < 8 {
			writeErr(w, 400, "新密码至少 8 位")
			return
		}
		h, _ := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
		db.Exec(`UPDATE users SET password=? WHERE id=?`, string(h), u.ID)
		db.Exec(`DELETE FROM sessions WHERE user_id=? AND token<>?`, u.ID, bearer(r))
	}
	if strings.TrimSpace(req.Name) != "" {
		db.Exec(`UPDATE users SET name=? WHERE id=?`, strings.TrimSpace(req.Name), u.ID)
	}
	db.Exec(`UPDATE users SET avatar=? WHERE id=?`, req.Avatar, u.ID)
	writeJSON(w, userFromToken(bearer(r)))
}

func ensureAdmin(email, pass string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(pass) < 8 {
		pass = randToken(6)
		println("generated password:", pass)
	}
	h, _ := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	var id int64
	err := db.QueryRow(`SELECT id FROM users WHERE email=?`, email).Scan(&id)
	if err == sql.ErrNoRows {
		name := strings.Split(email, "@")[0]
		_, err = exec(`INSERT INTO users(email,name,password,role,created_at) VALUES(?,?,?,'admin',?)`, email, name, string(h), now())
		return err
	}
	_, err = db.Exec(`UPDATE users SET password=?, role='admin', disabled=0 WHERE id=?`, string(h), id)
	return err
}

// ---- user management ----

func listUsers(w http.ResponseWriter, r *http.Request, u *User) {
	rs, err := queryMaps(`SELECT id,email,name,role,avatar,disabled,created_at,last_seen FROM users ORDER BY id`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	for _, x := range rs {
		x["online"] = hub.agentOnline(x["id"].(int64))
	}
	writeJSON(w, rs)
}

func createUser(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct{ Email, Name, Password, Role string }
	if readJSON(r, &req) != nil || req.Email == "" || len(req.Password) < 8 {
		writeErr(w, 400, "请填写邮箱，密码至少 8 位")
		return
	}
	if req.Role != "admin" {
		req.Role = "agent"
	}
	if req.Name == "" {
		req.Name = strings.Split(req.Email, "@")[0]
	}
	h, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	id, err := exec(`INSERT INTO users(email,name,password,role,created_at) VALUES(?,?,?,?,?)`,
		strings.ToLower(strings.TrimSpace(req.Email)), req.Name, string(h), req.Role, now())
	if err != nil {
		writeErr(w, 400, "邮箱已存在")
		return
	}
	// new members join every public channel
	db.Exec(`INSERT OR IGNORE INTO channel_members(channel_id,user_id) SELECT id,? FROM channels WHERE kind='public'`, id)
	writeJSON(w, M{"id": id})
}

func updateUser(w http.ResponseWriter, r *http.Request, u *User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var req M
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	if id == u.ID {
		delete(req, "role")
		delete(req, "disabled")
	}
	if p, ok := req["password"].(string); ok && p != "" {
		if len(p) < 8 {
			writeErr(w, 400, "密码至少 8 位")
			return
		}
		h, _ := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)
		db.Exec(`UPDATE users SET password=? WHERE id=?`, string(h), id)
		db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	}
	if err := updateFields("users", id, req, []string{"name", "role", "disabled"}); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if d, _ := req["disabled"].(bool); d {
		db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	}
	writeJSON(w, M{"ok": true})
}

func deleteUser(w http.ResponseWriter, r *http.Request, u *User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if id == u.ID {
		writeErr(w, 400, "不能删除自己")
		return
	}
	db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	db.Exec(`DELETE FROM channel_members WHERE user_id=?`, id)
	db.Exec(`UPDATE conversations SET assignee_id=0 WHERE assignee_id=?`, id)
	db.Exec(`DELETE FROM users WHERE id=?`, id)
	writeJSON(w, M{"ok": true})
}
