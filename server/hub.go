package main

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Conn struct {
	ws     *websocket.Conn
	send   chan []byte
	ctx    context.Context
	cancel context.CancelFunc
}

func newConn(ws *websocket.Conn) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{ws: ws, send: make(chan []byte, 64), ctx: ctx, cancel: cancel}
	go c.writeLoop()
	return c
}

func (c *Conn) writeLoop() {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case b := <-c.send:
			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			err := c.ws.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.Close()
				return
			}
		case <-ping.C:
			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			err := c.ws.Ping(ctx)
			cancel()
			if err != nil {
				c.Close()
				return
			}
		}
	}
}

func (c *Conn) Close() {
	c.cancel()
	c.ws.Close(websocket.StatusNormalClosure, "")
}

func (c *Conn) Send(b []byte) {
	select {
	case c.send <- b:
	default: // slow consumer: drop the connection rather than block the hub
		go c.Close()
	}
}

func event(typ string, data any) []byte {
	b, _ := json.Marshal(M{"type": typ, "data": data})
	return b
}

// LiveVisitor is the in-memory state of a visitor that currently has the widget open.
type LiveVisitor struct {
	VID            string          `json:"id"`
	SiteID         int64           `json:"site_id"`
	Name           string          `json:"name"`
	Email          string          `json:"email"`
	IP             string          `json:"ip"`
	Country        string          `json:"country"`
	Region         string          `json:"region"`
	City           string          `json:"city"`
	Browser        string          `json:"browser"`
	OS             string          `json:"os"`
	Device         string          `json:"device"`
	Lang           string          `json:"lang"`
	Referrer       string          `json:"referrer"`
	URL            string          `json:"url"`
	Title          string          `json:"title"`
	ConnectedAt    int64           `json:"connected_at"`
	PageSince      int64           `json:"page_since"`
	Pages          int             `json:"pages"`
	Visits         int64           `json:"visits"`
	Ext            json.RawMessage `json:"ext"`
	ConversationID int64           `json:"conversation_id"`
	Chatting       bool            `json:"chatting"`
	conns          []*Conn
	offlineTimer   *time.Timer
}

type Hub struct {
	mu       sync.RWMutex
	visitors map[string]*LiveVisitor
	agents   map[int64][]*Conn
}

var hub *Hub

func newHub() *Hub {
	return &Hub{visitors: map[string]*LiveVisitor{}, agents: map[int64][]*Conn{}}
}

func (h *Hub) snapshot(v *LiveVisitor) LiveVisitor {
	cp := *v
	cp.conns = nil
	cp.offlineTimer = nil
	return cp
}

// addVisitor attaches a connection; returns true when the visitor just came online.
func (h *Hub) addVisitor(lv *LiveVisitor, c *Conn) (*LiveVisitor, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.visitors[lv.VID]; ok {
		if cur.offlineTimer != nil {
			cur.offlineTimer.Stop()
			cur.offlineTimer = nil
		}
		cur.conns = append(cur.conns, c)
		return cur, false
	}
	lv.conns = []*Conn{c}
	h.visitors[lv.VID] = lv
	return lv, true
}

func (h *Hub) removeVisitor(vid string, c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.visitors[vid]
	if !ok {
		return
	}
	for i, x := range v.conns {
		if x == c {
			v.conns = append(v.conns[:i], v.conns[i+1:]...)
			break
		}
	}
	if len(v.conns) == 0 && v.offlineTimer == nil {
		// grace period so page navigations on multi-page sites do not flap
		v.offlineTimer = time.AfterFunc(12*time.Second, func() {
			h.mu.Lock()
			cur, ok := h.visitors[vid]
			gone := ok && cur == v && len(cur.conns) == 0
			if gone {
				delete(h.visitors, vid)
			}
			h.mu.Unlock()
			if gone {
				db.Exec(`UPDATE visitors SET last_seen=? WHERE id=?`, now(), vid)
				h.broadcastAgents(event("visitor_offline", M{"id": vid}))
			}
		})
	}
}

// updateVisitor mutates live state under lock and broadcasts the result.
func (h *Hub) updateVisitor(vid string, fn func(v *LiveVisitor)) {
	h.mu.Lock()
	v, ok := h.visitors[vid]
	if ok {
		fn(v)
	}
	var snap LiveVisitor
	if ok {
		snap = h.snapshot(v)
	}
	h.mu.Unlock()
	if ok {
		h.broadcastAgents(event("visitor_update", snap))
	}
}

func (h *Hub) getVisitor(vid string) (LiveVisitor, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	v, ok := h.visitors[vid]
	if !ok {
		return LiveVisitor{}, false
	}
	return h.snapshot(v), true
}

func (h *Hub) liveVisitors() []LiveVisitor {
	h.mu.RLock()
	out := make([]LiveVisitor, 0, len(h.visitors))
	for _, v := range h.visitors {
		out = append(out, h.snapshot(v))
	}
	h.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectedAt > out[j].ConnectedAt })
	return out
}

func (h *Hub) sendVisitor(vid string, b []byte) {
	h.mu.RLock()
	v, ok := h.visitors[vid]
	var conns []*Conn
	if ok {
		conns = append(conns, v.conns...)
	}
	h.mu.RUnlock()
	for _, c := range conns {
		c.Send(b)
	}
}

func (h *Hub) addAgent(uid int64, c *Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.agents[uid] = append(h.agents[uid], c)
	return len(h.agents[uid]) == 1
}

func (h *Hub) removeAgent(uid int64, c *Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	cs := h.agents[uid]
	for i, x := range cs {
		if x == c {
			cs = append(cs[:i], cs[i+1:]...)
			break
		}
	}
	if len(cs) == 0 {
		delete(h.agents, uid)
		return true
	}
	h.agents[uid] = cs
	return false
}

func (h *Hub) agentOnline(uid int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.agents[uid]) > 0
}

func (h *Hub) anyAgentOnline() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.agents) > 0
}

func (h *Hub) onlineAgentIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := []int64{}
	for id := range h.agents {
		ids = append(ids, id)
	}
	return ids
}

func (h *Hub) broadcastAgents(b []byte) {
	h.mu.RLock()
	var conns []*Conn
	for _, cs := range h.agents {
		conns = append(conns, cs...)
	}
	h.mu.RUnlock()
	for _, c := range conns {
		c.Send(b)
	}
}

func (h *Hub) sendAgents(uids []int64, b []byte) {
	h.mu.RLock()
	var conns []*Conn
	for _, id := range uids {
		conns = append(conns, h.agents[id]...)
	}
	h.mu.RUnlock()
	for _, c := range conns {
		c.Send(b)
	}
}

// broadcastAgentStatus tells every visitor whether a human agent is online.
func (h *Hub) broadcastAgentStatus() {
	online := h.anyAgentOnline()
	h.mu.RLock()
	var conns []*Conn
	for _, v := range h.visitors {
		conns = append(conns, v.conns...)
	}
	h.mu.RUnlock()
	b := event("agents_online", online)
	for _, c := range conns {
		c.Send(b)
	}
}
