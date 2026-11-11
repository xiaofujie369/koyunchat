package main

// Telegram bridge.
//  1. Community rooms <-> Telegram groups (rooms.tg_chat_id), both directions.
//  2. Support inbox <-> one Telegram "support" group (setting tg_support_chat_id): each customer
//     conversation is mirrored into its own forum topic (or reply-threaded when the group is not a
//     forum); agents reply from Telegram and the reply reaches the visitor.
// Uses long polling (getUpdates), so no public webhook is needed. Use a dedicated bot.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type tgUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

type tgChat struct {
	ID      int64  `json:"id"`
	Type    string `json:"type"`
	Title   string `json:"title"`
	IsForum bool   `json:"is_forum"`
}

type tgFile struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	FileSize int64  `json:"file_size"`
}

type tgMessage struct {
	MessageID int64                   `json:"message_id"`
	ThreadID  int64                   `json:"message_thread_id"`
	IsTopic   bool                    `json:"is_topic_message"`
	From      *tgUser                 `json:"from"`
	Chat      tgChat                  `json:"chat"`
	Text      string                  `json:"text"`
	Caption   string                  `json:"caption"`
	Photo     []tgFile                `json:"photo"`
	Document  *tgFile                 `json:"document"`
	Video     *tgFile                 `json:"video"`
	Voice     *tgFile                 `json:"voice"`
	Audio     *tgFile                 `json:"audio"`
	Sticker   *struct{ Emoji string } `json:"sticker"`
	ReplyTo   *tgMessage              `json:"reply_to_message"`
}

type tgUpdate struct {
	UpdateID      int64      `json:"update_id"`
	Message       *tgMessage `json:"message"`
	EditedMessage *tgMessage `json:"edited_message"`
	MyChatMember  *struct {
		Chat tgChat `json:"chat"`
	} `json:"my_chat_member"`
}

var tg = struct {
	sync.Mutex
	token    string
	botID    int64
	username string
	running  bool
	lastErr  string
	cancel   context.CancelFunc
	bindings map[int64]int64 // tg chat id -> room id
	queue    chan func()
}{bindings: map[int64]int64{}, queue: make(chan func(), 2000)}

var tgHTTP = &http.Client{Timeout: 75 * time.Second}

func initTelegram() {
	db.Exec(`ALTER TABLE conversations ADD COLUMN tg_topic_id INTEGER NOT NULL DEFAULT 0`) // ignore "duplicate column"
	db.Exec(`CREATE TABLE IF NOT EXISTS tg_support_map(chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, conversation_id INTEGER NOT NULL, PRIMARY KEY(chat_id,msg_id))`)
	db.Exec(`CREATE TABLE IF NOT EXISTS tg_chats(id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', is_forum INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL DEFAULT 0)`)
	go func() { // single sender keeps message order and respects rate limits
		for job := range tg.queue {
			job()
		}
	}()
	tgRefreshBindings()
	tgRestart()
}

func tgEnqueue(f func()) {
	select {
	case tg.queue <- f:
	default:
		log.Printf("telegram queue full, dropping job")
	}
}

func tgToken() string {
	tg.Lock()
	defer tg.Unlock()
	return tg.token
}

// tgCall performs a Bot API call; params may be a map (JSON) or a *multipart body via tgUpload.
func tgCall(method string, params any) (json.RawMessage, error) {
	token := tgToken()
	if token == "" {
		return nil, errors.New("telegram not configured")
	}
	b, _ := json.Marshal(params)
	for attempt := 0; attempt < 3; attempt++ {
		resp, err := tgHTTP.Post("https://api.telegram.org/bot"+token+"/"+method, "application/json", bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		res, retry, err := tgDecode(resp)
		if retry > 0 {
			time.Sleep(time.Duration(retry) * time.Second)
			continue
		}
		return res, err
	}
	return nil, errors.New("telegram rate limited")
}

func tgDecode(resp *http.Response) (json.RawMessage, int, error) {
	defer resp.Body.Close()
	var out struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		Description string          `json:"description"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, 0, err
	}
	if !out.OK {
		if out.Parameters.RetryAfter > 0 {
			return nil, out.Parameters.RetryAfter, nil
		}
		return nil, 0, errors.New(out.Description)
	}
	return out.Result, 0, nil
}

func tgUpload(method string, fields map[string]string, fileField, filePath string) (json.RawMessage, error) {
	token := tgToken()
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		mw.WriteField(k, v)
	}
	fw, _ := mw.CreateFormFile(fileField, filepath.Base(filePath))
	io.Copy(fw, f)
	mw.Close()
	resp, err := tgHTTP.Post("https://api.telegram.org/bot"+token+"/"+method, mw.FormDataContentType(), &buf)
	if err != nil {
		return nil, err
	}
	res, _, err := tgDecode(resp)
	return res, err
}

func tgRestart() {
	tg.Lock()
	if tg.cancel != nil {
		tg.cancel()
		tg.cancel = nil
	}
	tg.token = getSetting("tg_bot_token", "")
	tg.running, tg.lastErr, tg.botID, tg.username = false, "", 0, ""
	token := tg.token
	tg.Unlock()
	if token == "" {
		return
	}
	res, err := tgCall("getMe", M{})
	if err != nil {
		tg.Lock()
		tg.lastErr = "Bot Token 无效：" + err.Error()
		tg.Unlock()
		return
	}
	var me tgUser
	json.Unmarshal(res, &me)
	// a webhook would block getUpdates
	tgCall("deleteWebhook", M{"drop_pending_updates": false})
	ctx, cancel := context.WithCancel(context.Background())
	tg.Lock()
	tg.botID, tg.username, tg.running, tg.cancel = me.ID, me.Username, true, cancel
	tg.Unlock()
	go tgPoll(ctx)
}

func tgPoll(ctx context.Context) {
	offset, _ := strconv.ParseInt(getSetting("tg_offset", "0"), 10, 64)
	for ctx.Err() == nil {
		res, err := tgCall("getUpdates", M{"offset": offset, "timeout": 50, "allowed_updates": []string{"message", "edited_message", "my_chat_member"}})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			tg.Lock()
			tg.lastErr = err.Error()
			tg.Unlock()
			time.Sleep(5 * time.Second)
			continue
		}
		var ups []tgUpdate
		json.Unmarshal(res, &ups)
		for _, u := range ups {
			offset = u.UpdateID + 1
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("telegram update panic: %v", r)
					}
				}()
				tgHandle(u)
			}()
		}
		if len(ups) > 0 {
			setSetting("tg_offset", strconv.FormatInt(offset, 10))
		}
	}
}

func tgRememberChat(c tgChat) {
	if c.Type != "group" && c.Type != "supergroup" {
		return
	}
	forum := 0
	if c.IsForum {
		forum = 1
	}
	db.Exec(`INSERT INTO tg_chats(id,title,type,is_forum,seen_at) VALUES(?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, is_forum=excluded.is_forum, seen_at=excluded.seen_at`,
		c.ID, c.Title, c.Type, forum, now())
}

func tgHandle(u tgUpdate) {
	if u.MyChatMember != nil {
		tgRememberChat(u.MyChatMember.Chat)
		return
	}
	msg, edited := u.Message, false
	if msg == nil {
		msg, edited = u.EditedMessage, true
	}
	if msg == nil {
		return
	}
	tgRememberChat(msg.Chat)
	tg.Lock()
	botID := tg.botID
	roomID := tg.bindings[msg.Chat.ID]
	tg.Unlock()
	if msg.From != nil && msg.From.ID == botID {
		return
	}
	if strconv.FormatInt(msg.Chat.ID, 10) == getSetting("tg_support_chat_id", "") {
		tgHandleSupport(msg, edited)
		return
	}
	if roomID > 0 {
		tgHandleRoom(roomID, msg, edited)
	}
}

func tgName(u *tgUser) string {
	if u == nil {
		return "Telegram"
	}
	n := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if n == "" {
		n = u.Username
	}
	return clip(n, 40)
}

// tgContent turns a Telegram message into text plus an optional stored attachment.
func tgContent(msg *tgMessage) (string, string) {
	text := msg.Text
	if text == "" {
		text = msg.Caption
	}
	var f *tgFile
	name := ""
	switch {
	case len(msg.Photo) > 0:
		f = &msg.Photo[len(msg.Photo)-1]
		name = "photo.jpg"
	case msg.Document != nil:
		f, name = msg.Document, msg.Document.FileName
	case msg.Video != nil:
		f, name = msg.Video, "video.mp4"
	case msg.Voice != nil:
		f, name = msg.Voice, "voice.ogg"
	case msg.Audio != nil:
		f, name = msg.Audio, msg.Audio.FileName
	case msg.Sticker != nil:
		if text == "" {
			text = msg.Sticker.Emoji + " [贴纸]"
		}
	}
	if f == nil {
		return text, ""
	}
	att, err := tgDownload(f, name)
	if err != nil {
		label := "[文件]"
		if name != "" {
			label = "[文件: " + name + "]"
		}
		return strings.TrimSpace(text + " " + label), ""
	}
	b, _ := json.Marshal(att)
	return text, string(b)
}

func tgDownload(f *tgFile, name string) (M, error) {
	if f.FileSize > 20<<20 {
		return nil, errors.New("too large")
	}
	res, err := tgCall("getFile", M{"file_id": f.FileID})
	if err != nil {
		return nil, err
	}
	var fi struct {
		FilePath string `json:"file_path"`
	}
	json.Unmarshal(res, &fi)
	if name == "" {
		name = path.Base(fi.FilePath)
	}
	if filepath.Ext(name) == "" {
		name += filepath.Ext(fi.FilePath)
	}
	resp, err := tgHTTP.Get("https://api.telegram.org/file/bot" + tgToken() + "/" + fi.FilePath)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return storeFile(name, resp.Body)
}

// ---------------- community rooms ----------------

func tgRefreshBindings() {
	rows, _ := queryMaps(`SELECT id,tg_chat_id FROM rooms WHERE tg_chat_id<>''`)
	m := map[int64]int64{}
	for _, r := range rows {
		if cid, err := strconv.ParseInt(strings.TrimSpace(r["tg_chat_id"].(string)), 10, 64); err == nil {
			m[cid] = r["id"].(int64)
		}
	}
	tg.Lock()
	tg.bindings = m
	tg.Unlock()
}

func tgHandleRoom(roomID int64, msg *tgMessage, edited bool) {
	if edited {
		text := msg.Text
		if text == "" {
			text = msg.Caption
		}
		var id int64
		if db.QueryRow(`SELECT id FROM room_messages WHERE room_id=? AND tg_msg_id=?`, roomID, msg.MessageID).Scan(&id) == nil {
			db.Exec(`UPDATE room_messages SET body=? WHERE id=?`, clip(text, 4000), id)
			broadcastRoom(roomID, event("room_message", roomMessage(id)))
		}
		return
	}
	room, err := loadRoom(roomID)
	if err != nil {
		return
	}
	text, att := tgContent(msg)
	if strings.TrimSpace(text) == "" && att == "" {
		return
	}
	var replyTo int64
	if msg.ReplyTo != nil {
		db.QueryRow(`SELECT id FROM room_messages WHERE room_id=? AND tg_msg_id=?`, roomID, msg.ReplyTo.MessageID).Scan(&replyTo)
	}
	var uid int64
	if msg.From != nil {
		uid = msg.From.ID
	}
	m := insertRoomMessage(room, "tg", uid, tgName(msg.From), clip(text, 4000), att, replyTo)
	db.Exec(`UPDATE room_messages SET tg_msg_id=? WHERE id=?`, msg.MessageID, m["id"])
}

func tgEsc(s string) string { return html.EscapeString(s) }

func uploadPath(u string) string {
	return filepath.Join(dataDir, "uploads", filepath.FromSlash(strings.TrimPrefix(u, "/uploads/")))
}

// tgSend posts text and/or an attachment; returns the Telegram message id.
func tgSend(chatID string, threadID, replyTo int64, text string, att any) (int64, error) {
	var a M
	if am, ok := att.(map[string]any); ok {
		a = am
	}
	params := M{"chat_id": chatID, "parse_mode": "HTML"}
	if threadID > 0 {
		params["message_thread_id"] = threadID
	}
	if replyTo > 0 {
		params["reply_parameters"] = M{"message_id": replyTo, "allow_sending_without_reply": true}
	}
	var res json.RawMessage
	var err error
	if a != nil {
		u, _ := a["url"].(string)
		typ, _ := a["type"].(string)
		method, field := "sendDocument", "document"
		if strings.HasPrefix(typ, "image/") && !strings.HasSuffix(u, ".gif") {
			method, field = "sendPhoto", "photo"
		}
		fields := map[string]string{"chat_id": chatID, "parse_mode": "HTML", "caption": clip(text, 1000)}
		if threadID > 0 {
			fields["message_thread_id"] = strconv.FormatInt(threadID, 10)
		}
		if replyTo > 0 {
			rp, _ := json.Marshal(params["reply_parameters"])
			fields["reply_parameters"] = string(rp)
		}
		res, err = tgUpload(method, fields, field, uploadPath(u))
	} else {
		params["text"] = clip(text, 4000)
		params["link_preview_options"] = M{"is_disabled": true}
		res, err = tgCall("sendMessage", params)
	}
	if err != nil {
		return 0, err
	}
	var sent struct {
		MessageID int64 `json:"message_id"`
	}
	json.Unmarshal(res, &sent)
	return sent.MessageID, nil
}

func tgForward(room *Room, m M) {
	if room.TGChatID == "" || tgToken() == "" {
		return
	}
	name := fmt.Sprint(m["sender_name"])
	if m["sender_kind"] == "staff" {
		name += " · 客服"
	}
	text := "<b>" + tgEsc(name) + "</b>\n" + tgEsc(fmt.Sprint(m["body"]))
	var replyTG int64
	if rid, _ := m["reply_to"].(int64); rid > 0 {
		db.QueryRow(`SELECT tg_msg_id FROM room_messages WHERE id=?`, rid).Scan(&replyTG)
	}
	id, att, chat := m["id"], m["attachment"], room.TGChatID
	tgEnqueue(func() {
		mid, err := tgSend(chat, 0, replyTG, text, att)
		if err != nil {
			log.Printf("telegram forward room %d: %v", room.ID, err)
			return
		}
		db.Exec(`UPDATE room_messages SET tg_msg_id=? WHERE id=?`, mid, id)
	})
}

func tgDelete(roomID, msgID int64) {
	var chat string
	var tgID int64
	db.QueryRow(`SELECT r.tg_chat_id, m.tg_msg_id FROM room_messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=?`, msgID).Scan(&chat, &tgID)
	if chat == "" || tgID == 0 || tgToken() == "" {
		return
	}
	tgEnqueue(func() { tgCall("deleteMessage", M{"chat_id": chat, "message_id": tgID}) })
}

// ---------------- support inbox ----------------

func tgSupportChat() (string, bool) {
	chat := getSetting("tg_support_chat_id", "")
	if chat == "" || tgToken() == "" {
		return "", false
	}
	var forum int64
	db.QueryRow(`SELECT is_forum FROM tg_chats WHERE id=?`, chat).Scan(&forum)
	return chat, forum == 1
}

// tgSupportMirror copies a conversation message into the Telegram support group.
func tgSupportMirror(convID int64, m M) {
	chat, forum := tgSupportChat()
	if chat == "" || m == nil {
		return
	}
	if sid, _ := m["sender_id"].(int64); sid == tgOriginSender {
		return // came from Telegram in the first place
	}
	body := tgEsc(fmt.Sprint(m["body"]))
	name := tgEsc(fmt.Sprint(m["sender_name"]))
	var line string
	switch m["sender_type"] {
	case "visitor":
		line = "👤 " + body
	case "agent":
		line = "🧑‍💼 <b>" + name + "</b>: " + body
	case "ai":
		line = "🤖 <b>" + name + "</b>: " + body
	case "note":
		line = "📝 <i>备注 " + name + "</i>: " + body
	default:
		line = "ℹ️ <i>" + body + "</i>"
	}
	att := m["attachment"]
	tgEnqueue(func() {
		var topic int64
		db.QueryRow(`SELECT tg_topic_id FROM conversations WHERE id=?`, convID).Scan(&topic)
		text := line
		if forum && topic == 0 {
			topic = tgCreateTopic(chat, convID)
		}
		if !forum {
			text = "<b>#" + strconv.FormatInt(convID, 10) + " " + tgEsc(convTitle(convID)) + "</b>\n" + line
		}
		mid, err := tgSend(chat, topic, 0, text, att)
		if err != nil {
			log.Printf("telegram support mirror conv %d: %v", convID, err)
			return
		}
		db.Exec(`INSERT OR IGNORE INTO tg_support_map(chat_id,msg_id,conversation_id) VALUES(?,?,?)`, chat, mid, convID)
	})
}

func convTitle(convID int64) string {
	c := convRow(convID)
	if c == nil {
		return ""
	}
	for _, k := range []string{"visitor_name", "visitor_email"} {
		if s, _ := c[k].(string); s != "" {
			return s
		}
	}
	return "访客 " + clip(fmt.Sprint(c["visitor_id"]), 6)
}

// tgCreateTopic opens a forum topic for a conversation and posts the visitor card. Runs on the send queue.
func tgCreateTopic(chat string, convID int64) int64 {
	c := convRow(convID)
	if c == nil {
		return 0
	}
	res, err := tgCall("createForumTopic", M{"chat_id": chat, "name": clip(convTitle(convID)+" · "+fmt.Sprint(c["site_name"])+" #"+strconv.FormatInt(convID, 10), 120)})
	if err != nil {
		log.Printf("telegram create topic: %v", err)
		return 0
	}
	var t struct {
		ID int64 `json:"message_thread_id"`
	}
	json.Unmarshal(res, &t)
	db.Exec(`UPDATE conversations SET tg_topic_id=? WHERE id=?`, t.ID, convID)
	card := []string{"🆕 <b>新会话 #" + strconv.FormatInt(convID, 10) + "</b> · " + tgEsc(fmt.Sprint(c["site_name"]))}
	if v := visitorDetail(fmt.Sprint(c["visitor_id"])); v != nil {
		card = append(card, "IP: "+tgEsc(fmt.Sprint(v["ip"]))+" · "+tgEsc(geoLine(v)))
		if s := describeExt(fmt.Sprint(v["ext"])); s != "" {
			card = append(card, "账户: "+tgEsc(s))
		}
		if live, ok := v["live"].(LiveVisitor); ok && live.URL != "" {
			card = append(card, "页面: "+tgEsc(live.Title)+" "+tgEsc(live.URL))
		}
	}
	card = append(card, "直接在本话题回复即可发给访客；发送 /close 结束会话。")
	if base := strings.TrimRight(getSetting("console_url", ""), "/"); base != "" {
		card = append(card, base+"/#/inbox/"+strconv.FormatInt(convID, 10))
	}
	tgSend(chat, t.ID, 0, strings.Join(card, "\n"), nil)
	return t.ID
}

func geoLine(v M) string {
	parts := []string{}
	for _, k := range []string{"country", "region", "city"} {
		if s, _ := v[k].(string); s != "" && !strings.Contains(strings.Join(parts, " "), s) {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}

// tgOriginSender marks agent messages that were written in Telegram (so they are not echoed back).
const tgOriginSender = -1

func tgHandleSupport(msg *tgMessage, edited bool) {
	if edited {
		return
	}
	var convID int64
	if msg.ThreadID > 0 && msg.IsTopic {
		db.QueryRow(`SELECT id FROM conversations WHERE tg_topic_id=? ORDER BY id DESC LIMIT 1`, msg.ThreadID).Scan(&convID)
	}
	if convID == 0 && msg.ReplyTo != nil {
		db.QueryRow(`SELECT conversation_id FROM tg_support_map WHERE chat_id=? AND msg_id=?`, msg.Chat.ID, msg.ReplyTo.MessageID).Scan(&convID)
	}
	if convID == 0 {
		return
	}
	name := tgName(msg.From)
	if t := strings.TrimSpace(msg.Text); strings.HasPrefix(t, "/close") {
		closeConversation(convID, name)
		return
	}
	if t := strings.TrimSpace(msg.Text); strings.HasPrefix(t, "/note ") {
		m := insertMessage(convID, "note", tgOriginSender, name, strings.TrimPrefix(t, "/note "), "")
		hub.broadcastAgents(event("message", M{"message": m, "conversation": convRow(convID)}))
		return
	}
	text, att := tgContent(msg)
	if strings.TrimSpace(text) == "" && att == "" {
		return
	}
	if _, err := deliverAgentMessage(convID, tgOriginSender, name, clip(text, 8000), att); err != nil {
		log.Printf("telegram support reply conv %d: %v", convID, err)
	}
}

func tgStatus() M {
	tg.Lock()
	st := M{"configured": tg.token != "", "running": tg.running, "bot": tg.username, "error": tg.lastErr}
	tg.Unlock()
	chats, _ := queryMaps(`SELECT id,title,type,is_forum,seen_at FROM tg_chats ORDER BY seen_at DESC`)
	for _, c := range chats {
		c["id"] = strconv.FormatInt(c["id"].(int64), 10) // keep 64-bit ids exact in JS
	}
	st["chats"] = chats
	st["support_chat_id"] = getSetting("tg_support_chat_id", "")
	return st
}

func tgStatusHandler(w http.ResponseWriter, r *http.Request, u *User) { writeJSON(w, tgStatus()) }
