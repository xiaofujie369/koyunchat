package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var db *sql.DB

const schema = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  avatar TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site_key TEXT UNIQUE NOT NULL,
  domains TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0071e3',
  title TEXT NOT NULL DEFAULT '在线客服',
  welcome TEXT NOT NULL DEFAULT '您好，有什么可以帮您？',
  offline_msg TEXT NOT NULL DEFAULT '客服暂时不在线，请留言，我们会尽快回复您。',
  position TEXT NOT NULL DEFAULT 'right',
  ai_mode TEXT NOT NULL DEFAULT 'off',
  ai_name TEXT NOT NULL DEFAULT 'AI 助手',
  ai_prompt TEXT NOT NULL DEFAULT '',
  knowledge TEXT NOT NULL DEFAULT '',
  xboard INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS visitors(
  id TEXT PRIMARY KEY,
  site_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visitors_site ON visitors(site_id, last_seen);
CREATE TABLE IF NOT EXISTS page_views(
  id INTEGER PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  site_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pv_visitor ON page_views(visitor_id, ts);
CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL,
  visitor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assignee_id INTEGER NOT NULL DEFAULT 0,
  ai_paused INTEGER NOT NULL DEFAULT 0,
  last_msg TEXT NOT NULL DEFAULT '',
  last_at INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor_id, status);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(status, last_at);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id INTEGER NOT NULL DEFAULT 0,
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS canned(
  id INTEGER PRIMARY KEY,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  dm_key TEXT UNIQUE,
  created_by INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channel_members(
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_messages(
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cm_channel ON channel_messages(channel_id, id);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

func openDB(path string) error {
	var err error
	db, err = sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(8000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(4)
	_, err = db.Exec(schema)
	return err
}

func now() int64 { return time.Now().UnixMilli() }

type M = map[string]any

// queryMaps runs a query and returns every row as a column->value map.
func queryMaps(q string, args ...any) ([]M, error) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []M{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := M{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func queryMap(q string, args ...any) (M, error) {
	rs, err := queryMaps(q, args...)
	if err != nil {
		return nil, err
	}
	if len(rs) == 0 {
		return nil, sql.ErrNoRows
	}
	return rs[0], nil
}

func exec(q string, args ...any) (int64, error) {
	r, err := db.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func getSetting(key, def string) string {
	var v string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v); err != nil {
		return def
	}
	return v
}

func setSetting(key, value string) error {
	_, err := db.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// updateFields builds "UPDATE table SET a=?,b=? WHERE id=?" for whitelisted keys present in data.
func updateFields(table string, id any, data M, allowed []string) error {
	sets := []string{}
	args := []any{}
	for _, k := range allowed {
		if v, ok := data[k]; ok {
			if b, isBool := v.(bool); isBool {
				if b {
					v = 1
				} else {
					v = 0
				}
			}
			sets = append(sets, k+"=?")
			args = append(args, v)
		}
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	_, err := db.Exec(fmt.Sprintf("UPDATE %s SET %s WHERE id=?", table, strings.Join(sets, ",")), args...)
	return err
}
