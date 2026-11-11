package main

import (
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

var (
	dataDir   string
	secretKey []byte
	apiURL    string
	adminPath string
)

func main() {
	// 参数也可以用环境变量设置（Docker 部署时用）：KC_ADDR / KC_DATA / KC_API_URL
	addr := flag.String("addr", envOr("KC_ADDR", "127.0.0.1:8790"), "listen address (env KC_ADDR)")
	flag.StringVar(&dataDir, "data", envOr("KC_DATA", "/opt/tawk/data"), "data directory (env KC_DATA)")
	flag.StringVar(&apiURL, "api-url", os.Getenv("KC_API_URL"), "public base URL used in embed code, e.g. https://chatapi.example.com (env KC_API_URL)")
	adminEmail := flag.String("admin-email", "", "create/reset admin account with this email")
	adminPass := flag.String("admin-pass", "", "password for -admin-email")
	flag.Parse()

	os.MkdirAll(filepath.Join(dataDir, "uploads"), 0o755)
	if err := openDB(filepath.Join(dataDir, "chat.db")); err != nil {
		log.Fatal(err)
	}
	if err := initCommunity(); err != nil {
		log.Fatal(err)
	}
	if err := initPlugins(); err != nil {
		log.Fatal(err)
	}
	if err := initAnalytics(); err != nil {
		log.Fatal(err)
	}
	secretKey = loadSecret()
	adminPath = getSetting("admin_path", "")
	if adminPath == "" {
		adminPath = randToken(4)
		setSetting("admin_path", adminPath)
	}
	if *adminEmail != "" {
		if err := ensureAdmin(*adminEmail, *adminPass); err != nil {
			log.Fatal(err)
		}
		log.Printf("admin %s ready", *adminEmail)
		return
	}
	openGeo(filepath.Join(dataDir, "geo.mmdb"))
	hub = newHub()
	initTelegram()
	go housekeeping()

	mux := http.NewServeMux()
	registerRoutes(mux)
	srv := &http.Server{Addr: *addr, Handler: logMiddleware(mux), ReadHeaderTimeout: 15 * time.Second}
	log.Printf("listening on %s, console at /%s/", *addr, adminPath)
	log.Fatal(srv.ListenAndServe())
}

func loadSecret() []byte {
	if s := getSetting("secret", ""); s != "" {
		b, _ := hex.DecodeString(s)
		return b
	}
	b := make([]byte, 32)
	rand.Read(b)
	setSetting("secret", hex.EncodeToString(b))
	return b
}

func webSub() fs.FS {
	web, _ := fs.Sub(webFS, "web")
	return web
}

func registerRoutes(mux *http.ServeMux) {
	registerCommunityRoutes(mux)
	registerSoundRoutes(mux)
	registerPluginRoutes(mux)
	registerStatsRoutes(mux)
	registerAnalyticsRoutes(mux)
	mux.HandleFunc("GET /api/telegram/status", admin(tgStatusHandler))
	web := webSub()
	static := http.FileServer(http.FS(web))
	mux.Handle("GET /app/", noCache(static))
	// 新版管理面板（React）：/admin/assets/ 下的文件名带内容哈希，可以长期缓存
	mux.HandleFunc("GET /admin/assets/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") { // 不列目录
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		static.ServeHTTP(w, r)
	})
	// 新版客户社区（Vue）的静态资源
	mux.HandleFunc("GET /user/assets/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") { // 不列目录
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Ping(); err != nil {
			http.Error(w, "db error", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	mux.Handle("GET /vendor/", noCache(static))
	mux.HandleFunc("GET /widget.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=300")
		http.ServeFileFS(w, r, web, "widget.js")
	})
	// "/" is the customer community; the agent console lives at a secret path (like Xboard's admin path)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		switch strings.Trim(r.URL.Path, "/") {
		case "":
			serveUser(w)
		case adminPath:
			if !strings.HasSuffix(r.URL.Path, "/") {
				http.Redirect(w, r, "/"+adminPath+"/", http.StatusFound)
				return
			}
			serveAdmin(w)
		case adminPath + "/legacy":
			// 旧版管理面板，新版稳定前保留作对照和备用
			if !strings.HasSuffix(r.URL.Path, "/") {
				http.Redirect(w, r, "/"+adminPath+"/legacy/", http.StatusFound)
				return
			}
			serveIndex(w, "index.html")
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("GET /uploads/", serveUpload)

	// widget / visitor
	mux.HandleFunc("GET /ws/visitor", visitorWS)
	mux.HandleFunc("POST /api/widget/upload", widgetUpload)
	mux.HandleFunc("OPTIONS /api/widget/upload", corsPreflight)

	// auth
	mux.HandleFunc("POST /api/auth/login", login)
	mux.HandleFunc("POST /api/auth/logout", auth(logout))
	mux.HandleFunc("GET /api/me", auth(me))
	mux.HandleFunc("PUT /api/me", auth(updateMe))
	mux.HandleFunc("GET /ws/agent", agentWS)
	mux.HandleFunc("GET /api/bootstrap", auth(bootstrap))
	mux.HandleFunc("GET /api/stats", auth(stats))
	mux.HandleFunc("POST /api/upload", auth(agentUpload))

	// conversations
	mux.HandleFunc("GET /api/conversations", auth(listConversations))
	mux.HandleFunc("GET /api/conversations/{id}", auth(getConversation))
	mux.HandleFunc("POST /api/conversations/{id}/messages", auth(postAgentMessage))
	mux.HandleFunc("POST /api/conversations/{id}/update", auth(updateConversation))
	mux.HandleFunc("POST /api/conversations/{id}/read", auth(readConversation))
	mux.HandleFunc("GET /api/visitors", auth(listVisitors))
	mux.HandleFunc("GET /api/visitors/{vid}", auth(getVisitor))
	mux.HandleFunc("PUT /api/visitors/{vid}", auth(updateVisitor))
	mux.HandleFunc("POST /api/visitors/{vid}/chat", auth(startChat))

	// AI
	mux.HandleFunc("POST /api/ai/suggest", auth(aiSuggest))
	mux.HandleFunc("POST /api/ai/summarize", auth(aiSummarize))
	mux.HandleFunc("POST /api/ai/rewrite", auth(aiRewrite))

	// team chat
	mux.HandleFunc("GET /api/channels", auth(listChannels))
	mux.HandleFunc("POST /api/channels", auth(createChannel))
	mux.HandleFunc("POST /api/channels/dm", auth(openDM))
	mux.HandleFunc("GET /api/channels/{id}", auth(getChannel))
	mux.HandleFunc("PUT /api/channels/{id}", auth(updateChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", auth(deleteChannel))
	mux.HandleFunc("GET /api/channels/{id}/messages", auth(channelMessages))
	mux.HandleFunc("POST /api/channels/{id}/messages", auth(postChannelMessage))
	mux.HandleFunc("POST /api/channels/{id}/members", auth(addChannelMembers))
	mux.HandleFunc("DELETE /api/channels/{id}/members/{uid}", auth(removeChannelMember))
	mux.HandleFunc("POST /api/channels/{id}/read", auth(readChannel))

	// admin
	mux.HandleFunc("GET /api/sites", auth(listSites))
	mux.HandleFunc("POST /api/sites", admin(createSite))
	mux.HandleFunc("PUT /api/sites/{id}", admin(updateSite))
	mux.HandleFunc("DELETE /api/sites/{id}", admin(deleteSite))
	mux.HandleFunc("GET /api/users", auth(listUsers))
	mux.HandleFunc("POST /api/users", admin(createUser))
	mux.HandleFunc("PUT /api/users/{id}", admin(updateUser))
	mux.HandleFunc("DELETE /api/users/{id}", admin(deleteUser))
	mux.HandleFunc("GET /api/canned", auth(listCanned))
	mux.HandleFunc("POST /api/canned", auth(createCanned))
	mux.HandleFunc("PUT /api/canned/{id}", auth(updateCanned))
	mux.HandleFunc("DELETE /api/canned/{id}", auth(deleteCanned))
	mux.HandleFunc("GET /api/settings", admin(getSettings))
	mux.HandleFunc("PUT /api/settings", admin(putSettings))
	mux.HandleFunc("POST /api/settings/ai-test", admin(aiTest))
	mux.HandleFunc("POST /api/settings/ai-models", admin(aiModels))
}

var assetVersion = func() string {
	h := sha256.New()
	for _, f := range []string{"web/app/app.js", "web/app/app.css", "web/app/icons.js", "web/c/c.js", "web/c/c.css", "web/vendor/vue.global.prod.js"} {
		b, _ := webFS.ReadFile(f)
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))[:10]
}()

// serveIndex serves an HTML shell with ?v=<content hash> appended to local script/style URLs.
func serveIndex(w http.ResponseWriter, name string) {
	b, err := fs.ReadFile(webSub(), name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	html := strings.NewReplacer(`.js"`, `.js?v=`+assetVersion+`"`, `.css"`, `.css?v=`+assetVersion+`"`).Replace(string(b))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(html))
}

// serveUser 返回新版客户社区；没有编译前端时退回旧版
func serveUser(w http.ResponseWriter) {
	b, err := fs.ReadFile(webSub(), "user/index.html")
	if err != nil {
		serveIndex(w, "c/index.html")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}

// serveAdmin 返回新版管理面板；没有编译前端时退回旧版
func serveAdmin(w http.ResponseWriter) {
	b, err := fs.ReadFile(webSub(), "admin/index.html")
	if err != nil {
		serveIndex(w, "index.html")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func logMiddleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		h.ServeHTTP(w, r)
	})
}

func corsPreflight(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.WriteHeader(204)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(M{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20)).Decode(v)
}

// clientIP prefers the Cloudflare header forwarded by Caddy, then the proxy peer.
func clientIP(r *http.Request) string {
	for _, h := range []string{"X-CF-IP", "X-Real-IP"} {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" && net.ParseIP(v) != nil {
			return v
		}
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return strings.TrimSpace(strings.Split(v, ",")[0])
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func randToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func housekeeping() {
	for {
		db.Exec(`DELETE FROM sessions WHERE expires_at < ?`, now())
		// 浏览记录保留天数（系统设置 → 访问统计，默认 365 天）
		db.Exec(`DELETE FROM page_views WHERE ts < ?`, now()-int64(pvRetentionDays())*24*3600*1000)
		time.Sleep(time.Hour)
	}
}
