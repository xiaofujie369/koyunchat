package main

import (
	"path/filepath"
	"testing"
)

// Offline test of the Telegram bridge's inbound handling (no Bot API calls: no token is set).
func TestTelegramInbound(t *testing.T) {
	dataDir = t.TempDir()
	if err := openDB(filepath.Join(dataDir, "t.db")); err != nil {
		t.Fatal(err)
	}
	initCommunity()
	hub = newHub()
	initTelegram()
	tg.botID = 42

	roomID, _ := exec(`INSERT INTO rooms(name,kind,tg_chat_id,created_at) VALUES('大厅','public','-100123',?)`, now())
	tgRefreshBindings()
	chat := tgChat{ID: -100123, Type: "supergroup", Title: "TG 大厅"}
	alice := &tgUser{ID: 7, FirstName: "Alice", LastName: "W"}

	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 501, From: alice, Chat: chat, Text: "hello from tg"}})
	m, err := queryMap(`SELECT * FROM room_messages WHERE room_id=? AND tg_msg_id=501`, roomID)
	if err != nil || m["sender_kind"] != "tg" || m["sender_name"] != "Alice W" || m["body"] != "hello from tg" {
		t.Fatalf("room message not bridged: %v %v", m, err)
	}
	// reply mapping + edit
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 502, From: alice, Chat: chat, Text: "reply", ReplyTo: &tgMessage{MessageID: 501}}})
	r, _ := queryMap(`SELECT reply_to FROM room_messages WHERE tg_msg_id=502`)
	if r["reply_to"] != m["id"] {
		t.Fatalf("reply not mapped: %v", r)
	}
	tgHandle(tgUpdate{EditedMessage: &tgMessage{MessageID: 501, From: alice, Chat: chat, Text: "edited"}})
	e, _ := queryMap(`SELECT body FROM room_messages WHERE tg_msg_id=501`)
	if e["body"] != "edited" {
		t.Fatalf("edit not applied: %v", e)
	}
	// own bot messages are ignored (no loops); unbound chats are ignored
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 503, From: &tgUser{ID: 42, IsBot: true}, Chat: chat, Text: "echo"}})
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 504, From: alice, Chat: tgChat{ID: -100555, Type: "group", Title: "x"}, Text: "other"}})
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM room_messages`).Scan(&n)
	if n != 2 {
		t.Fatalf("expected 2 bridged messages, got %d", n)
	}
	// discovered chats are remembered for the console
	db.QueryRow(`SELECT COUNT(*) FROM tg_chats`).Scan(&n)
	if n != 2 {
		t.Fatalf("expected 2 discovered chats, got %d", n)
	}

	// support group: reply in a conversation's topic reaches the conversation as an agent message
	exec(`INSERT INTO sites(id,name,site_key,created_at) VALUES(1,'s','k',0)`)
	exec(`INSERT INTO visitors(id,site_id,first_seen,last_seen) VALUES('v1',1,0,0)`)
	convID, _ := exec(`INSERT INTO conversations(site_id,visitor_id,status,tg_topic_id,created_at,last_at) VALUES(1,'v1','open',77,0,0)`)
	setSetting("tg_support_chat_id", "-100999")
	sup := tgChat{ID: -100999, Type: "supergroup", Title: "客服群", IsForum: true}
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 9, ThreadID: 77, IsTopic: true, From: alice, Chat: sup, Text: "您好，这边帮您查一下"}})
	a, err := queryMap(`SELECT * FROM messages WHERE conversation_id=? AND sender_type='agent'`, convID)
	if err != nil || a["body"] != "您好，这边帮您查一下" || a["sender_id"] != int64(tgOriginSender) {
		t.Fatalf("support reply not delivered: %v %v", a, err)
	}
	var paused int64
	db.QueryRow(`SELECT ai_paused FROM conversations WHERE id=?`, convID).Scan(&paused)
	if paused != 1 {
		t.Fatal("human reply from TG should pause AI")
	}
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 10, ThreadID: 77, IsTopic: true, From: alice, Chat: sup, Text: "/note 老客户"}})
	db.QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id=? AND sender_type='note'`, convID).Scan(&n)
	if n != 1 {
		t.Fatal("/note not recorded")
	}
	tgHandle(tgUpdate{Message: &tgMessage{MessageID: 11, ThreadID: 77, IsTopic: true, From: alice, Chat: sup, Text: "/close"}})
	var status string
	db.QueryRow(`SELECT status FROM conversations WHERE id=?`, convID).Scan(&status)
	if status != "closed" {
		t.Fatalf("/close did not close conversation: %s", status)
	}
}
