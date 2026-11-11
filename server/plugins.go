package main

// 插件管理（仿 Xboard 插件）：每个插件可以单独启用、停用。
// 第一个插件是「邮件插件」：管理员自己填写发件邮箱（SMTP），客服可以给离线客户发邮件。

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"mime"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

const pluginSchema = `
CREATE TABLE IF NOT EXISTS plugins(
  code TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mail_senders(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 465,
  security TEXT NOT NULL DEFAULT 'ssl',
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mail_logs(
  id INTEGER PRIMARY KEY,
  sender_id INTEGER NOT NULL DEFAULT 0,
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  visitor_id TEXT NOT NULL DEFAULT '',
  conversation_id INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_logs_visitor ON mail_logs(visitor_id, id);`

// pluginCatalog 是内置插件清单，以后新增插件在这里登记
var pluginCatalog = []M{
	{"code": "mail", "name": "邮件插件", "version": "1.0.0", "icon": "✉️",
		"description": "给离线客户发送邮件。发件邮箱由你自己填写（支持任意 SMTP 服务），可以添加多个、修改、删除；会话右侧的访客资料里会出现「发送邮件」按钮，收件地址自动带入客户邮箱，也可以手动改。"},
}

func initPlugins() error {
	_, err := db.Exec(pluginSchema + soundSchema)
	return err
}

func pluginEnabled(code string) bool {
	var v int
	db.QueryRow(`SELECT enabled FROM plugins WHERE code=?`, code).Scan(&v)
	return v == 1
}

func pluginStates() M {
	out := M{}
	for _, p := range pluginCatalog {
		code := p["code"].(string)
		out[code] = pluginEnabled(code)
	}
	return out
}

func registerPluginRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/plugins", admin(listPlugins))
	mux.HandleFunc("PUT /api/plugins/{code}", admin(updatePlugin))

	mux.HandleFunc("GET /api/mail/senders", auth(mailOn(listMailSenders)))
	mux.HandleFunc("POST /api/mail/senders", admin(saveMailSender))
	mux.HandleFunc("PUT /api/mail/senders/{id}", admin(saveMailSender))
	mux.HandleFunc("DELETE /api/mail/senders/{id}", admin(deleteMailSender))
	mux.HandleFunc("POST /api/mail/senders/{id}/test", admin(testMailSender))
	mux.HandleFunc("POST /api/mail/send", auth(mailOn(sendMailHandler)))
	mux.HandleFunc("GET /api/mail/logs", auth(mailOn(listMailLogs)))
	mux.HandleFunc("DELETE /api/mail/logs/{id}", admin(deleteMailLog))
}

func listPlugins(w http.ResponseWriter, r *http.Request, u *User) {
	out := []M{}
	for _, p := range pluginCatalog {
		item := M{}
		for k, v := range p {
			item[k] = v
		}
		item["enabled"] = pluginEnabled(p["code"].(string))
		out = append(out, item)
	}
	writeJSON(w, out)
}

func updatePlugin(w http.ResponseWriter, r *http.Request, u *User) {
	code := r.PathValue("code")
	known := false
	for _, p := range pluginCatalog {
		if p["code"] == code {
			known = true
		}
	}
	if !known {
		writeErr(w, 404, "插件不存在")
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	v := 0
	if req.Enabled {
		v = 1
	}
	db.Exec(`INSERT INTO plugins(code,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`, code, v, now())
	hub.broadcastAgents(event("plugins", pluginStates()))
	listPlugins(w, r, u)
}

func mailOn(h authedHandler) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, u *User) {
		if !pluginEnabled("mail") {
			writeErr(w, 403, "邮件插件未启用，请到「插件管理」开启")
			return
		}
		h(w, r, u)
	}
}

// ---- 发件邮箱 ----

func listMailSenders(w http.ResponseWriter, r *http.Request, u *User) {
	rows, _ := queryMaps(`SELECT id,name,host,port,security,username,password,from_addr,from_name,is_default,updated_at FROM mail_senders ORDER BY is_default DESC, id`)
	for _, x := range rows {
		// 密码永远不返回给浏览器，只告诉前端有没有设置
		x["has_password"] = x["password"] != ""
		delete(x, "password")
		if u.Role != "admin" {
			delete(x, "host")
			delete(x, "port")
			delete(x, "username")
			delete(x, "security")
		}
	}
	writeJSON(w, rows)
}

func cleanHeader(s string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "").Replace(s))
}

func validAddr(s string) (string, bool) {
	s = cleanHeader(s)
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || !strings.Contains(s, "@") {
		return s, false
	}
	return s, true
}

func saveMailSender(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Name      string `json:"name"`
		Host      string `json:"host"`
		Port      int    `json:"port"`
		Security  string `json:"security"`
		Username  string `json:"username"`
		Password  string `json:"password"`
		FromAddr  string `json:"from_addr"`
		FromName  string `json:"from_name"`
		IsDefault bool   `json:"is_default"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	req.Host = cleanHeader(req.Host)
	if req.Host == "" || strings.ContainsAny(req.Host, " /:") {
		writeErr(w, 400, "请填写正确的 SMTP 服务器地址（只填域名或 IP，不要带 http:// 和端口）")
		return
	}
	if req.Port <= 0 || req.Port > 65535 {
		writeErr(w, 400, "端口不正确")
		return
	}
	if req.Security != "ssl" && req.Security != "starttls" && req.Security != "none" {
		req.Security = "ssl"
	}
	from, ok := validAddr(req.FromAddr)
	if !ok {
		writeErr(w, 400, "发件地址格式不正确")
		return
	}
	name := clip(cleanHeader(req.Name), 40)
	if name == "" {
		name = from
	}
	fromName := clip(cleanHeader(req.FromName), 60)
	user := clip(cleanHeader(req.Username), 200)
	t := now()
	idStr := r.PathValue("id")
	var id int64
	if idStr == "" {
		var err error
		id, err = exec(`INSERT INTO mail_senders(name,host,port,security,username,password,from_addr,from_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			name, req.Host, req.Port, req.Security, user, req.Password, from, fromName, t, t)
		if err != nil {
			writeErr(w, 500, "保存失败")
			return
		}
	} else {
		id, _ = strconv.ParseInt(idStr, 10, 64)
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM mail_senders WHERE id=?`, id).Scan(&n)
		if n == 0 {
			writeErr(w, 404, "发件邮箱不存在")
			return
		}
		db.Exec(`UPDATE mail_senders SET name=?,host=?,port=?,security=?,username=?,from_addr=?,from_name=?,updated_at=? WHERE id=?`,
			name, req.Host, req.Port, req.Security, user, from, fromName, t, id)
		// 密码留空 = 不修改，填 - = 清除
		if req.Password == "-" {
			db.Exec(`UPDATE mail_senders SET password='' WHERE id=?`, id)
		} else if req.Password != "" {
			db.Exec(`UPDATE mail_senders SET password=? WHERE id=?`, req.Password, id)
		}
	}
	var defaults int
	db.QueryRow(`SELECT COUNT(*) FROM mail_senders WHERE is_default=1 AND id<>?`, id).Scan(&defaults)
	if req.IsDefault || defaults == 0 {
		db.Exec(`UPDATE mail_senders SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END`, id)
	}
	listMailSenders(w, r, u)
}

func deleteMailSender(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	db.Exec(`DELETE FROM mail_senders WHERE id=?`, id)
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM mail_senders WHERE is_default=1`).Scan(&n)
	if n == 0 {
		db.Exec(`UPDATE mail_senders SET is_default=1 WHERE id=(SELECT MIN(id) FROM mail_senders)`)
	}
	listMailSenders(w, r, u)
}

type mailSender struct {
	ID                                                 int64
	Host, Security, Username, Password, From, FromName string
	Port                                               int
}

func loadSender(id int64) (*mailSender, error) {
	s := &mailSender{}
	q := `SELECT id,host,port,security,username,password,from_addr,from_name FROM mail_senders WHERE id=?`
	arg := any(id)
	if id == 0 {
		q = `SELECT id,host,port,security,username,password,from_addr,from_name FROM mail_senders ORDER BY is_default DESC, id LIMIT 1`
		arg = nil
	}
	var err error
	if arg == nil {
		err = db.QueryRow(q).Scan(&s.ID, &s.Host, &s.Port, &s.Security, &s.Username, &s.Password, &s.From, &s.FromName)
	} else {
		err = db.QueryRow(q, arg).Scan(&s.ID, &s.Host, &s.Port, &s.Security, &s.Username, &s.Password, &s.From, &s.FromName)
	}
	if err != nil {
		return nil, errors.New("还没有可用的发件邮箱，请管理员在「插件管理 → 邮件插件」里添加")
	}
	return s, nil
}

func b64Lines(s string) string {
	enc := base64.StdEncoding.EncodeToString([]byte(s))
	var b strings.Builder
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc)
	return b.String()
}

// buildMessage 生成 纯文本 + HTML 两种格式的邮件
func buildMessage(s *mailSender, to, subject, body string) []byte {
	from := s.From
	if s.FromName != "" {
		from = mime.QEncoding.Encode("utf-8", s.FromName) + " <" + s.From + ">"
	}
	domain := s.From[strings.LastIndex(s.From, "@")+1:]
	boundary := "kc-" + randToken(12)
	htmlBody := `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#222">` +
		strings.ReplaceAll(html.EscapeString(body), "\n", "<br>") + `</div>`
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("Message-ID: <" + randToken(16) + "@" + domain + ">\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
	b.WriteString("--" + boundary + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(b64Lines(body) + "\r\n")
	b.WriteString("--" + boundary + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")
	b.WriteString(b64Lines(htmlBody) + "\r\n")
	b.WriteString("--" + boundary + "--\r\n")
	return []byte(b.String())
}

// plainAuth 和 smtp.PlainAuth 一样，但允许在明文连接上登录（用户选择了「不加密」时）
type plainAuth struct{ user, pass string }

func (a plainAuth) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "PLAIN", []byte("\x00" + a.user + "\x00" + a.pass), nil
}
func (a plainAuth) Next(_ []byte, more bool) ([]byte, error) {
	if more {
		return nil, errors.New("unexpected server challenge")
	}
	return nil, nil
}

// loginAuth 用于只支持 AUTH LOGIN 的服务器（例如部分企业邮箱）
type loginAuth struct{ user, pass string }

func (a loginAuth) Start(_ *smtp.ServerInfo) (string, []byte, error) { return "LOGIN", nil, nil }
func (a loginAuth) Next(from []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimSpace(string(from))) {
	case "username:":
		return []byte(a.user), nil
	case "password:":
		return []byte(a.pass), nil
	}
	return nil, fmt.Errorf("unexpected server challenge: %s", from)
}

func smtpSend(s *mailSender, to, subject, body string) error {
	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	tlsCfg := &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}
	var conn net.Conn
	var err error
	if s.Security == "ssl" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("连接邮件服务器失败：%v", err)
	}
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("邮件服务器没有正常响应：%v", err)
	}
	defer c.Close()
	if err = c.Hello("localhost"); err != nil {
		return fmt.Errorf("握手失败：%v", err)
	}
	if s.Security == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("服务器不支持 STARTTLS，请把加密方式改成 SSL/TLS 或不加密")
		}
		if err = c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS 失败：%v", err)
		}
	}
	if s.Username != "" {
		ok, mechs := c.Extension("AUTH")
		if !ok {
			return errors.New("服务器不支持登录，请清空用户名后再试")
		}
		var a smtp.Auth = plainAuth{s.Username, s.Password}
		if !strings.Contains(strings.ToUpper(mechs), "PLAIN") && strings.Contains(strings.ToUpper(mechs), "LOGIN") {
			a = loginAuth{s.Username, s.Password}
		}
		if err = c.Auth(a); err != nil {
			return fmt.Errorf("登录失败，请检查用户名和密码（授权码）：%v", err)
		}
	}
	if err = c.Mail(s.From); err != nil {
		return fmt.Errorf("发件地址被拒绝：%v", err)
	}
	if err = c.Rcpt(to); err != nil {
		return fmt.Errorf("收件地址被拒绝：%v", err)
	}
	wc, err := c.Data()
	if err != nil {
		return fmt.Errorf("发送失败：%v", err)
	}
	if _, err = wc.Write(buildMessage(s, to, subject, body)); err != nil {
		wc.Close()
		return fmt.Errorf("发送失败：%v", err)
	}
	if err = wc.Close(); err != nil {
		return fmt.Errorf("服务器拒收：%v", err)
	}
	c.Quit()
	return nil
}

func testMailSender(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		To string `json:"to"`
	}
	readJSON(r, &req)
	to, ok := validAddr(req.To)
	if !ok {
		writeErr(w, 400, "请填写接收测试邮件的地址")
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s, err := loadSender(id)
	if err != nil || s.ID != id {
		writeErr(w, 404, "发件邮箱不存在")
		return
	}
	if rateLimited("mailtest:"+strconv.FormatInt(u.ID, 10), 10, 10*time.Minute) {
		writeErr(w, 429, "测试太频繁，请稍后再试")
		return
	}
	if err := smtpSend(s, to, "Koyun Chat 测试邮件", "这是一封测试邮件。\n收到这封邮件，说明发件邮箱 "+s.From+" 配置正确。"); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, M{"ok": true})
}

// ---- 发邮件 ----

func sendMailHandler(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		SenderID       int64  `json:"sender_id"`
		To             string `json:"to"`
		Subject        string `json:"subject"`
		Body           string `json:"body"`
		VisitorID      string `json:"visitor_id"`
		ConversationID int64  `json:"conversation_id"`
	}
	if readJSON(r, &req) != nil {
		writeErr(w, 400, "参数错误")
		return
	}
	to, ok := validAddr(req.To)
	if !ok {
		writeErr(w, 400, "收件地址格式不正确")
		return
	}
	subject := clip(cleanHeader(req.Subject), 200)
	body := strings.TrimSpace(req.Body)
	if subject == "" || body == "" {
		writeErr(w, 400, "请填写主题和正文")
		return
	}
	body = clip(body, 20000)
	s, err := loadSender(req.SenderID)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if rateLimited("mail:"+strconv.FormatInt(u.ID, 10), 30, 10*time.Minute) {
		writeErr(w, 429, "发送太频繁，10 分钟内最多 30 封")
		return
	}
	sendErr := smtpSend(s, to, subject, body)
	status, errText := "ok", ""
	if sendErr != nil {
		status, errText = "fail", clip(sendErr.Error(), 500)
	}
	exec(`INSERT INTO mail_logs(sender_id,from_addr,to_addr,subject,body,visitor_id,conversation_id,user_id,user_name,status,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		s.ID, s.From, to, subject, body, clip(req.VisitorID, 64), req.ConversationID, u.ID, u.Name, status, errText, now())
	if sendErr != nil {
		writeErr(w, 400, sendErr.Error())
		return
	}
	// 在会话里留一条内部备注，其他客服能看到已经发过邮件
	if req.ConversationID > 0 && convRow(req.ConversationID) != nil {
		m := insertMessage(req.ConversationID, "note", u.ID, u.Name, "已发送邮件给 "+to+"，主题："+subject, "")
		hub.broadcastAgents(event("message", M{"message": m, "conversation": convRow(req.ConversationID)}))
	}
	writeJSON(w, M{"ok": true})
}

func listMailLogs(w http.ResponseWriter, r *http.Request, u *User) {
	vid := r.URL.Query().Get("visitor_id")
	var rows []M
	if vid != "" {
		rows, _ = queryMaps(`SELECT id,from_addr,to_addr,subject,body,user_name,status,error,created_at FROM mail_logs WHERE visitor_id=? ORDER BY id DESC LIMIT 20`, vid)
	} else {
		rows, _ = queryMaps(`SELECT id,from_addr,to_addr,subject,body,visitor_id,user_name,status,error,created_at FROM mail_logs ORDER BY id DESC LIMIT 100`)
	}
	writeJSON(w, rows)
}

func deleteMailLog(w http.ResponseWriter, r *http.Request, u *User) {
	db.Exec(`DELETE FROM mail_logs WHERE id=?`, r.PathValue("id"))
	writeJSON(w, M{"ok": true})
}
