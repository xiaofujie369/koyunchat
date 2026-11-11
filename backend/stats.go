package main

// 仪表盘统计：数据卡（带环比）、按天趋势、区间汇总、客服工作量、排行。
// 按天分组用浏览器传来的时区（tz = 与 UTC 相差的分钟数），保证"今天"和客服看到的一致。

import (
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const dayMs = int64(24 * time.Hour / time.Millisecond)

func registerStatsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stats/overview", auth(statsOverview))
}

func countQ(q string, args ...any) int64 {
	var n int64
	db.QueryRow(q, args...).Scan(&n)
	return n
}

func statsOverview(w http.ResponseWriter, r *http.Request, u *User) {
	q := r.URL.Query()
	days, _ := strconv.Atoi(q.Get("days"))
	if days != 7 && days != 30 && days != 90 {
		days = 30
	}
	tzMin, _ := strconv.Atoi(q.Get("tz"))
	if tzMin < -720 || tzMin > 840 {
		tzMin = 0
	}
	loc := time.FixedZone("client", tzMin*60)
	off := int64(tzMin) * 60000

	t := time.Now().In(loc)
	today := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).UnixMilli()
	yesterday := today - dayMs
	monthStart := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc)
	lastMonthStart := monthStart.AddDate(0, -1, 0)
	// 上月同期：上月 1 号到上月"今天"同一时刻，和本月至今对比才公平
	lastMonthSame := lastMonthStart.Add(t.Sub(monthStart))
	if lastMonthSame.After(monthStart) {
		lastMonthSame = monthStart
	}
	ms, lms, lmSame := monthStart.UnixMilli(), lastMonthStart.UnixMilli(), lastMonthSame.UnixMilli()
	yNow := t.UnixMilli() - dayMs // 昨天同一时刻

	convIn := func(a, b int64) int64 {
		return countQ(`SELECT COUNT(*) FROM conversations WHERE created_at>=? AND created_at<?`, a, b)
	}
	visIn := func(a, b int64) int64 {
		return countQ(`SELECT COUNT(DISTINCT visitor_id) FROM page_views WHERE ts>=? AND ts<?`, a, b)
	}
	now := t.UnixMilli() + 1

	var avgRating float64
	var ratedMonth int64
	db.QueryRow(`SELECT COALESCE(AVG(rating),0), COUNT(*) FROM conversations WHERE rating>0 AND created_at>=?`, ms).Scan(&avgRating, &ratedMonth)
	var ratingAll float64
	db.QueryRow(`SELECT COALESCE(AVG(rating),0) FROM conversations WHERE rating>0`).Scan(&ratingAll)

	cards := M{
		"today_convs": convIn(today, now), "yesterday_convs": convIn(yesterday, yNow),
		"month_convs": convIn(ms, now), "last_month_convs": convIn(lms, lmSame),
		"open":           countQ(`SELECT COUNT(*) FROM conversations WHERE status='open'`),
		"unassigned":     countQ(`SELECT COUNT(*) FROM conversations WHERE status='open' AND assignee_id=0`),
		"unread":         countQ(`SELECT COALESCE(SUM(unread),0) FROM conversations WHERE status='open'`),
		"unread_convs":   countQ(`SELECT COUNT(*) FROM conversations WHERE status='open' AND unread>0`),
		"today_visitors": visIn(today, now), "yesterday_visitors": visIn(yesterday, yNow),
		"visitors_total":  countQ(`SELECT COUNT(*) FROM visitors`),
		"online_visitors": len(hub.liveVisitors()), "online_agents": len(hub.onlineAgentIDs()),
		"today_msgs":     countQ(`SELECT COUNT(*) FROM messages WHERE created_at>=? AND sender_type IN ('visitor','agent','ai')`, today),
		"yesterday_msgs": countQ(`SELECT COUNT(*) FROM messages WHERE created_at>=? AND created_at<? AND sender_type IN ('visitor','agent','ai')`, yesterday, yNow),
		"today_ai":       countQ(`SELECT COUNT(*) FROM messages WHERE created_at>=? AND sender_type='ai'`, today),
		"rating_month":   avgRating, "rated_month": ratedMonth, "rating_all": ratingAll,
	}

	// ---- 按天趋势 ----
	start := today - int64(days-1)*dayMs
	idx := func(ts int64) int { return int((ts + off) / dayMs) } // 客户时区的"第几天"
	base := idx(start)
	series := make([]M, days)
	for i := range series {
		d := time.UnixMilli(start + int64(i)*dayMs).In(loc)
		series[i] = M{"date": d.Format("2006-01-02"), "conversations": int64(0), "visitors": int64(0), "messages": int64(0), "ai": int64(0)}
	}
	fill := func(key, q string, args ...any) {
		rows, err := db.Query(q, args...)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var d, n int64
			if rows.Scan(&d, &n) == nil {
				if i := int(d) - base; i >= 0 && i < days {
					series[i][key] = n
				}
			}
		}
	}
	fill("conversations", `SELECT (created_at+?)/?, COUNT(*) FROM conversations WHERE created_at>=? GROUP BY 1`, off, dayMs, start)
	fill("visitors", `SELECT (ts+?)/?, COUNT(DISTINCT visitor_id) FROM page_views WHERE ts>=? GROUP BY 1`, off, dayMs, start)
	fill("messages", `SELECT (created_at+?)/?, COUNT(*) FROM messages WHERE created_at>=? AND sender_type IN ('visitor','agent','ai') GROUP BY 1`, off, dayMs, start)
	fill("ai", `SELECT (created_at+?)/?, COUNT(*) FROM messages WHERE created_at>=? AND sender_type='ai' GROUP BY 1`, off, dayMs, start)

	// ---- 区间汇总 ----
	var agentReplies, aiReplies int64
	db.QueryRow(`SELECT COALESCE(SUM(sender_type='agent'),0), COALESCE(SUM(sender_type='ai'),0) FROM messages WHERE created_at>=?`, start).Scan(&agentReplies, &aiReplies)
	// 首次响应：访客第一条消息到第一条客服 / AI 回复的时间
	var frSum, frN int64
	if rows, err := db.Query(`SELECT
		(SELECT MIN(created_at) FROM messages WHERE conversation_id=c.id AND sender_type='visitor'),
		(SELECT MIN(created_at) FROM messages WHERE conversation_id=c.id AND sender_type IN ('agent','ai'))
		FROM conversations c WHERE c.created_at>=?`, start); err == nil {
		for rows.Next() {
			var v, a *int64
			if rows.Scan(&v, &a) == nil && v != nil && a != nil && *a >= *v {
				frSum += *a - *v
				frN++
			}
		}
		rows.Close()
	}
	var rangeRating float64
	var rangeRated int64
	db.QueryRow(`SELECT COALESCE(AVG(rating),0), COUNT(*) FROM conversations WHERE rating>0 AND created_at>=?`, start).Scan(&rangeRating, &rangeRated)
	summary := M{
		"from": series[0]["date"], "to": series[days-1]["date"],
		"conversations": convIn(start, now), "visitors": visIn(start, now),
		"messages":      countQ(`SELECT COUNT(*) FROM messages WHERE created_at>=? AND sender_type IN ('visitor','agent','ai')`, start),
		"agent_replies": agentReplies, "ai_replies": aiReplies,
		"first_response_ms": func() int64 {
			if frN == 0 {
				return 0
			}
			return frSum / frN
		}(),
		"responded": frN, "rating": rangeRating, "rated": rangeRated,
	}

	// ---- 客服工作量（区间内）----
	agents, _ := queryMaps(`SELECT u.id, u.name, u.role,
		(SELECT COUNT(*) FROM conversations c WHERE c.assignee_id=u.id AND c.created_at>=?) AS conversations,
		(SELECT COUNT(*) FROM messages m WHERE m.sender_type='agent' AND m.sender_id=u.id AND m.created_at>=?) AS replies,
		(SELECT COALESCE(AVG(rating),0) FROM conversations c WHERE c.assignee_id=u.id AND c.rating>0 AND c.created_at>=?) AS rating,
		(SELECT COUNT(*) FROM conversations c WHERE c.assignee_id=u.id AND c.status='open') AS open_now
		FROM users u WHERE u.disabled=0 ORDER BY replies DESC, conversations DESC`, start, start, start)
	online := map[int64]bool{}
	for _, id := range hub.onlineAgentIDs() {
		online[id] = true
	}
	for _, a := range agents {
		a["online"] = online[a["id"].(int64)]
	}

	// ---- 排行（区间内）----
	sites, _ := queryMaps(`SELECT s.name, COUNT(c.id) AS n FROM sites s LEFT JOIN conversations c ON c.site_id=s.id AND c.created_at>=?
		GROUP BY s.id ORDER BY n DESC`, start)
	countries, _ := queryMaps(`SELECT CASE WHEN country='' THEN '未知' ELSE country END AS name, COUNT(*) AS n FROM visitors
		WHERE last_seen>=? GROUP BY 1 ORDER BY n DESC LIMIT 6`, start)
	refCount := map[string]int64{}
	if rows, err := db.Query(`SELECT referrer FROM visitors WHERE last_seen>=?`, start); err == nil {
		for rows.Next() {
			var ref string
			rows.Scan(&ref)
			refCount[refHost(ref)]++
		}
		rows.Close()
	}
	refs := []M{}
	for k, n := range refCount {
		refs = append(refs, M{"name": k, "n": n})
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i]["n"].(int64) > refs[j]["n"].(int64) })
	if len(refs) > 6 {
		refs = refs[:6]
	}

	writeJSON(w, M{"cards": cards, "series": series, "summary": summary, "agents": agents,
		"sites": sites, "countries": countries, "referrers": refs, "days": days})
}

// refHost 把来源地址归成域名；空的算"直接访问"
func refHost(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "直接访问"
	}
	if u, err := url.Parse(ref); err == nil && u.Host != "" {
		return strings.TrimPrefix(u.Hostname(), "www.")
	}
	return "其他"
}
