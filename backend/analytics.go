package main

// 访问统计：按小时 / 日 / 周 / 月统计浏览量、访客、新访客、IP、咨询；地区（国家 → 省份 → 城市）、IP、
// 受访页面、来源、设备、时段分布。时间按浏览器时区计算（tz = 与 UTC 相差的分钟数）。

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

func initAnalytics() error {
	// 老版本的 page_views 没有 ip / 地区列，补上（旧记录统计时用访客表里的 IP 代替）
	have := map[string]bool{}
	rows, err := db.Query(`PRAGMA table_info(page_views)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid, notnull, pk int
		var name, typ string
		var def any
		rows.Scan(&cid, &name, &typ, &notnull, &def, &pk)
		have[name] = true
	}
	rows.Close()
	for _, col := range []string{"ip", "country", "region", "city"} {
		if !have[col] {
			if _, err := db.Exec(`ALTER TABLE page_views ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	_, err = db.Exec(`CREATE INDEX IF NOT EXISTS idx_pv_ts ON page_views(ts);
		CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
		CREATE INDEX IF NOT EXISTS idx_visitors_first ON visitors(first_seen);`)
	return err
}

func pvRetentionDays() int {
	n, _ := strconv.Atoi(getSetting("pv_retention_days", "365"))
	if n < 30 || n > 3650 {
		return 365
	}
	return n
}

// visitorGeo 只读取在线访客的 IP 和地区（不广播）；不在线时从访客表取
func (h *Hub) visitorGeo(vid string) (ip, country, region, city string) {
	h.mu.RLock()
	v, ok := h.visitors[vid]
	if ok {
		ip, country, region, city = v.IP, v.Country, v.Region, v.City
	}
	h.mu.RUnlock()
	if !ok {
		db.QueryRow(`SELECT ip,country,region,city FROM visitors WHERE id=?`, vid).Scan(&ip, &country, &region, &city)
	}
	return
}

func registerAnalyticsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/analytics", auth(analyticsHandler))
	mux.HandleFunc("GET /api/analytics/ips", auth(analyticsIPs))
	mux.HandleFunc("GET /api/analytics/regions", auth(analyticsRegions))
}

// 统计范围：from / to（毫秒，含 from 不含 to）、站点、时区
type aRange struct {
	from, to int64
	site     int64
	off      int64 // 时区偏移（毫秒）
	tzMin    int
}

func parseRange(r *http.Request) (aRange, error) {
	q := r.URL.Query()
	var a aRange
	a.from, _ = strconv.ParseInt(q.Get("from"), 10, 64)
	a.to, _ = strconv.ParseInt(q.Get("to"), 10, 64)
	a.site, _ = strconv.ParseInt(q.Get("site"), 10, 64)
	a.tzMin, _ = strconv.Atoi(q.Get("tz"))
	if a.tzMin < -720 || a.tzMin > 840 {
		a.tzMin = 0
	}
	a.off = int64(a.tzMin) * 60000
	if a.to <= a.from || a.from <= 0 {
		return a, fmt.Errorf("时间范围不正确")
	}
	if a.to-a.from > 3700*dayMs {
		return a, fmt.Errorf("时间范围最长 10 年")
	}
	return a, nil
}

// pv 是浏览记录 + 访客表的联表；ipExpr 优先用记录里的 IP，旧记录用访客表的
const (
	pvFrom   = ` FROM page_views pv JOIN visitors v ON v.id=pv.visitor_id `
	ipExpr   = `COALESCE(NULLIF(pv.ip,''),v.ip)`
	ctyExpr  = `COALESCE(NULLIF(pv.country,''),NULLIF(v.country,''),'未知')`
	regExpr  = `COALESCE(NULLIF(pv.region,''),NULLIF(v.region,''),'未知')`
	cityExpr = `COALESCE(NULLIF(pv.city,''),NULLIF(v.city,''),'未知')`
)

func (a aRange) pvWhere() (string, []any) {
	w, args := ` WHERE pv.ts>=? AND pv.ts<? `, []any{a.from, a.to}
	if a.site > 0 {
		w += ` AND pv.site_id=? `
		args = append(args, a.site)
	}
	return w, args
}

func (a aRange) convWhere() (string, []any) {
	w, args := ` WHERE created_at>=? AND created_at<? `, []any{a.from, a.to}
	if a.site > 0 {
		w += ` AND site_id=? `
		args = append(args, a.site)
	}
	return w, args
}

// 汇总指标
func (a aRange) totals() M {
	w, args := a.pvWhere()
	var pv, uv, ips, newV int64
	db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT pv.visitor_id), COUNT(DISTINCT `+ipExpr+`),
		COUNT(DISTINCT CASE WHEN v.first_seen>=? THEN pv.visitor_id END)`+pvFrom+w, append([]any{a.from}, args...)...).Scan(&pv, &uv, &ips, &newV)
	cw, cargs := a.convWhere()
	var convs, chatV int64
	db.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT visitor_id) FROM conversations`+cw, cargs...).Scan(&convs, &chatV)
	// 平均浏览时长：同一访客同一天第一条到最后一条浏览记录的间隔（只看了 1 页的不计入）
	var avgDur float64
	db.QueryRow(`SELECT COALESCE(AVG(d),0) FROM (SELECT MAX(pv.ts)-MIN(pv.ts) AS d`+pvFrom+w+
		` GROUP BY pv.visitor_id, (pv.ts+?)/? HAVING COUNT(*)>1 AND d<6*3600000)`, append(args, a.off, dayMs)...).Scan(&avgDur)
	var bounce int64 // 只看了 1 页就走的访客
	db.QueryRow(`SELECT COUNT(*) FROM (SELECT pv.visitor_id`+pvFrom+w+` GROUP BY pv.visitor_id HAVING COUNT(*)=1)`, args...).Scan(&bounce)
	return M{"pv": pv, "uv": uv, "ips": ips, "new": newV, "returning": uv - newV, "conversations": convs,
		"chat_visitors": chatV, "avg_duration_ms": int64(avgDur), "single_page": bounce}
}

func analyticsHandler(w http.ResponseWriter, r *http.Request, u *User) {
	a, err := parseRange(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	gran := r.URL.Query().Get("gran")
	span := a.to - a.from
	if gran == "" {
		switch {
		case span <= 2*dayMs:
			gran = "hour"
		case span <= 92*dayMs:
			gran = "day"
		case span <= 366*dayMs:
			gran = "week"
		default:
			gran = "month"
		}
	}
	if gran == "hour" && span > 31*dayMs { // 小时粒度点太多
		gran = "day"
	}

	cur := a.totals()
	prev := aRange{from: a.from - span, to: a.from, site: a.site, off: a.off}.totals()

	// ---- 趋势 ----
	loc := time.FixedZone("c", a.tzMin*60)
	// {T} 换成时间列名；不用 fmt.Sprintf，因为 strftime 的 %Y 等会被当成格式符
	sec := `(({T}+` + strconv.FormatInt(a.off, 10) + `)/1000)`
	var fmtSQL string
	switch gran {
	case "hour":
		fmtSQL = `strftime('%Y-%m-%d %H:00',` + sec + `,'unixepoch')`
	case "week": // 以周一为一周的开始
		fmtSQL = `date(` + sec + `,'unixepoch','-6 days','weekday 1')`
	case "month":
		fmtSQL = `strftime('%Y-%m',` + sec + `,'unixepoch')`
	default:
		gran = "day"
		fmtSQL = `date(` + sec + `,'unixepoch')`
	}
	bucket := func(col string) string { return strings.ReplaceAll(fmtSQL, "{T}", col) }
	keys := bucketKeys(a.from, a.to, gran, loc)
	idx := map[string]int{}
	series := make([]M, len(keys))
	for i, k := range keys {
		idx[k] = i
		series[i] = M{"key": k, "pv": int64(0), "uv": int64(0), "new": int64(0), "ips": int64(0), "conversations": int64(0)}
	}
	pw, pargs := a.pvWhere()
	bk := bucket("pv.ts")
	if rows, err := db.Query(`SELECT `+bk+`, COUNT(*), COUNT(DISTINCT pv.visitor_id), COUNT(DISTINCT `+ipExpr+`)`+pvFrom+pw+` GROUP BY 1`, pargs...); err == nil {
		for rows.Next() {
			var k string
			var pv, uv, ips int64
			if rows.Scan(&k, &pv, &uv, &ips) == nil {
				if i, ok := idx[k]; ok {
					series[i]["pv"], series[i]["uv"], series[i]["ips"] = pv, uv, ips
				}
			}
		}
		rows.Close()
	}
	// 新访客：第一次访问落在这个时间段
	nw, nargs := ` WHERE first_seen>=? AND first_seen<? `, []any{a.from, a.to}
	if a.site > 0 {
		nw += ` AND site_id=? `
		nargs = append(nargs, a.site)
	}
	fillSeries(series, idx, "new", `SELECT `+bucket("first_seen")+`, COUNT(*) FROM visitors`+nw+` GROUP BY 1`, nargs...)
	cw, cargs := a.convWhere()
	fillSeries(series, idx, "conversations", `SELECT `+bucket("created_at")+`, COUNT(*) FROM conversations`+cw+` GROUP BY 1`, cargs...)

	// ---- 各种分布 ----
	top := func(expr string, limit int) []M {
		rs, _ := queryMaps(`SELECT `+expr+` AS name, COUNT(DISTINCT pv.visitor_id) AS uv, COUNT(*) AS pv`+pvFrom+pw+
			` GROUP BY 1 ORDER BY uv DESC, pv DESC LIMIT `+strconv.Itoa(limit), pargs...)
		return rs
	}
	// 国家：再加上新访客数和咨询人数
	countries, _ := queryMaps(`SELECT `+ctyExpr+` AS name, COUNT(DISTINCT pv.visitor_id) AS uv, COUNT(*) AS pv,
		COUNT(DISTINCT `+ipExpr+`) AS ips, COUNT(DISTINCT CASE WHEN v.first_seen>=? THEN pv.visitor_id END) AS new`+pvFrom+pw+
		` GROUP BY 1 ORDER BY uv DESC, pv DESC LIMIT 50`, append([]any{a.from}, pargs...)...)
	chatBy := map[string]int64{}
	if rows, err := db.Query(`SELECT COALESCE(NULLIF(v.country,''),'未知'), COUNT(DISTINCT c.visitor_id) FROM conversations c JOIN visitors v ON v.id=c.visitor_id
		WHERE c.created_at>=? AND c.created_at<?`+map[bool]string{true: ` AND c.site_id=?`, false: ``}[a.site > 0]+` GROUP BY 1`,
		append([]any{a.from, a.to}, siteArg(a.site)...)...); err == nil {
		for rows.Next() {
			var k string
			var n int64
			rows.Scan(&k, &n)
			chatBy[k] = n
		}
		rows.Close()
	}
	for _, c := range countries {
		c["chats"] = chatBy[c["name"].(string)]
	}

	pages, _ := queryMaps(`SELECT pv.url AS url, MAX(pv.title) AS title, COUNT(*) AS pv, COUNT(DISTINCT pv.visitor_id) AS uv`+pvFrom+pw+
		` GROUP BY pv.url ORDER BY pv DESC LIMIT 20`, pargs...)
	// 来源：访客第一次进站时的来源，按域名归类
	refs := map[string][2]int64{}
	if rows, err := db.Query(`SELECT v.referrer, COUNT(*) `+pvFrom+pw+` GROUP BY pv.visitor_id`, pargs...); err == nil {
		for rows.Next() {
			var ref string
			var n int64
			rows.Scan(&ref, &n)
			k := refHost(ref)
			x := refs[k]
			refs[k] = [2]int64{x[0] + 1, x[1] + n}
		}
		rows.Close()
	}
	referrers := []M{}
	for k, x := range refs {
		referrers = append(referrers, M{"name": k, "uv": x[0], "pv": x[1]})
	}
	sort.Slice(referrers, func(i, j int) bool { return referrers[i]["uv"].(int64) > referrers[j]["uv"].(int64) })
	if len(referrers) > 12 {
		referrers = referrers[:12]
	}

	// 时段：一天 24 小时、一周 7 天各有多少浏览
	hours := make([]int64, 24)
	weekdays := make([]int64, 7)
	if rows, err := db.Query(`SELECT CAST(strftime('%H',((pv.ts+?)/1000),'unixepoch') AS INTEGER), CAST(strftime('%w',((pv.ts+?)/1000),'unixepoch') AS INTEGER), COUNT(*)`+
		pvFrom+pw+` GROUP BY 1,2`, append([]any{a.off, a.off}, pargs...)...); err == nil {
		for rows.Next() {
			var h, wd int
			var n int64
			if rows.Scan(&h, &wd, &n) == nil && h >= 0 && h < 24 && wd >= 0 && wd < 7 {
				hours[h] += n
				weekdays[wd] += n
			}
		}
		rows.Close()
	}

	writeJSON(w, M{
		"gran": gran, "totals": cur, "prev": prev, "series": series,
		"countries": countries, "regions": top(ctyExpr+`||' · '||`+regExpr, 15), "cities": top(ctyExpr+`||' · '||`+cityExpr, 15),
		"pages": pages, "referrers": referrers,
		"devices": top(`COALESCE(NULLIF(v.device,''),'未知')`, 8), "os": top(`COALESCE(NULLIF(v.os,''),'未知')`, 10),
		"browsers": top(`COALESCE(NULLIF(v.browser,''),'未知')`, 10), "langs": top(`COALESCE(NULLIF(v.lang,''),'未知')`, 10),
		"hours": hours, "weekdays": weekdays,
		"retention_days": pvRetentionDays(),
	})
}

func siteArg(site int64) []any {
	if site > 0 {
		return []any{site}
	}
	return nil
}

func fillSeries(series []M, idx map[string]int, key, q string, args ...any) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var n int64
		if rows.Scan(&k, &n) == nil {
			if i, ok := idx[k]; ok {
				series[i][key] = n
			}
		}
	}
}

// bucketKeys 列出范围内的每个时间段（没有数据的也要有，图表才连续）
func bucketKeys(from, to int64, gran string, loc *time.Location) []string {
	t := time.UnixMilli(from).In(loc)
	end := time.UnixMilli(to - 1).In(loc)
	keys := []string{}
	switch gran {
	case "hour":
		t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, loc)
		for !t.After(end) && len(keys) < 2000 {
			keys = append(keys, t.Format("2006-01-02 15:04"))
			t = t.Add(time.Hour)
		}
	case "week":
		t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		t = t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7)) // 回到周一
		for !t.After(end) && len(keys) < 2000 {
			keys = append(keys, t.Format("2006-01-02"))
			t = t.AddDate(0, 0, 7)
		}
	case "month":
		t = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc)
		for !t.After(end) && len(keys) < 2000 {
			keys = append(keys, t.Format("2006-01"))
			t = t.AddDate(0, 1, 0)
		}
	default:
		t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		for !t.After(end) && len(keys) < 4000 {
			keys = append(keys, t.Format("2006-01-02"))
			t = t.AddDate(0, 0, 1)
		}
	}
	return keys
}

// 某个国家下的省份 / 城市明细
func analyticsRegions(w http.ResponseWriter, r *http.Request, u *User) {
	a, err := parseRange(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	country := r.URL.Query().Get("country")
	pw, pargs := a.pvWhere()
	pw += ` AND ` + ctyExpr + `=? `
	pargs = append(pargs, country)
	q := func(expr string) []M {
		rs, _ := queryMaps(`SELECT `+expr+` AS name, COUNT(DISTINCT pv.visitor_id) AS uv, COUNT(*) AS pv, COUNT(DISTINCT `+ipExpr+`) AS ips`+
			pvFrom+pw+` GROUP BY 1 ORDER BY uv DESC, pv DESC LIMIT 50`, pargs...)
		return rs
	}
	writeJSON(w, M{"regions": q(regExpr), "cities": q(regExpr + `||' · '||` + cityExpr)})
}

// IP 明细：每个 IP 的访客数、浏览量、地区、最后访问；可以按 IP / 地区搜索
func analyticsIPs(w http.ResponseWriter, r *http.Request, u *User) {
	a, err := parseRange(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	pw, pargs := a.pvWhere()
	if s := strings.TrimSpace(r.URL.Query().Get("q")); s != "" {
		like := "%" + s + "%"
		pw += ` AND (` + ipExpr + ` LIKE ? OR ` + ctyExpr + ` LIKE ? OR ` + regExpr + ` LIKE ? OR ` + cityExpr + ` LIKE ?) `
		pargs = append(pargs, like, like, like, like)
	}
	rows, _ := queryMaps(`SELECT `+ipExpr+` AS ip, MAX(`+ctyExpr+`) AS country, MAX(`+regExpr+`) AS region, MAX(`+cityExpr+`) AS city,
		COUNT(DISTINCT pv.visitor_id) AS uv, COUNT(*) AS pv, MAX(pv.ts) AS last_ts, MAX(v.blocked) AS blocked,
		MAX(v.id) AS visitor_id, MAX(NULLIF(v.email,'')) AS email
		`+pvFrom+pw+` GROUP BY 1 ORDER BY pv DESC LIMIT 200`, pargs...)
	writeJSON(w, rows)
}
