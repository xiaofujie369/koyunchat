package main

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/oschwald/maxminddb-golang/v2"
)

// ---- uploads ----

var allowedExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".pdf": true, ".txt": true, ".log": true, ".csv": true, ".json": true,
	".zip": true, ".rar": true, ".7z": true, ".gz": true,
	".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".mp4": true, ".mov": true, ".webm": true, ".mp3": true, ".m4a": true, ".wav": true, ".ogg": true,
}

const maxUpload = 20 << 20

func saveUpload(w http.ResponseWriter, r *http.Request) (M, string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+(1<<20))
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, "文件过大（最大 20MB）或上传失败"
	}
	defer f.Close()
	if !allowedExt[strings.ToLower(filepath.Ext(hdr.Filename))] {
		return nil, "不支持的文件类型"
	}
	m, err := storeFile(hdr.Filename, f)
	if err != nil {
		return nil, "保存失败"
	}
	return m, ""
}

// storeFile saves r under uploads/YYYY/MM with a random name; the extension must be allowed.
func storeFile(filename string, r io.Reader) (M, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	if !allowedExt[ext] {
		return nil, errors.New("unsupported file type")
	}
	sub := time.Now().Format("2006/01")
	dir := filepath.Join(dataDir, "uploads", sub)
	os.MkdirAll(dir, 0o755)
	name := randToken(12) + ext
	out, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		return nil, err
	}
	defer out.Close()
	n, err := io.Copy(out, io.LimitReader(r, maxUpload))
	if err != nil {
		return nil, err
	}
	return M{"url": "/uploads/" + sub + "/" + name, "name": clip(filename, 120), "size": n, "type": mime.TypeByExtension(ext)}, nil
}

func agentUpload(w http.ResponseWriter, r *http.Request, u *User) {
	m, errMsg := saveUpload(w, r)
	if errMsg != "" {
		writeErr(w, 400, errMsg)
		return
	}
	writeJSON(w, m)
}

func widgetUpload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	vid, tok := r.URL.Query().Get("vid"), r.URL.Query().Get("vtoken")
	if !validVisitor(vid, tok) {
		writeErr(w, 403, "invalid visitor")
		return
	}
	if rateLimited("up:"+vid, 10, 10*time.Minute) {
		writeErr(w, 429, "上传太频繁")
		return
	}
	m, errMsg := saveUpload(w, r)
	if errMsg != "" {
		writeErr(w, 400, errMsg)
		return
	}
	writeJSON(w, m)
}

func serveUpload(w http.ResponseWriter, r *http.Request) {
	p := path.Clean(strings.TrimPrefix(r.URL.Path, "/uploads/"))
	ext := strings.ToLower(filepath.Ext(p))
	if strings.Contains(p, "..") || !allowedExt[ext] {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "public, max-age=2592000")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".webm", ".mp3", ".m4a", ".wav", ".ogg", ".pdf":
	default:
		w.Header().Set("Content-Disposition", "attachment")
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, filepath.Join(dataDir, "uploads", filepath.FromSlash(p)))
}

// ---- GeoIP ----

var geoDB *maxminddb.Reader

func openGeo(p string) {
	if r, err := maxminddb.Open(p); err == nil {
		geoDB = r
	}
}

type Geo struct{ Country, Region, City string }

func pickName(names map[string]string) string {
	if v := names["zh-CN"]; v != "" {
		return v
	}
	return names["en"]
}

func lookupGeo(ip string) Geo {
	if geoDB == nil {
		return Geo{}
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return Geo{}
	}
	var rec struct {
		Country struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"country"`
		City struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"city"`
		Subdivisions []struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"subdivisions"`
	}
	if geoDB.Lookup(addr).Decode(&rec) != nil {
		return Geo{}
	}
	g := Geo{Country: pickName(rec.Country.Names), City: pickName(rec.City.Names)}
	if len(rec.Subdivisions) > 0 {
		g.Region = pickName(rec.Subdivisions[0].Names)
	}
	return g
}

// ---- user agent ----

func parseUA(ua string) (browser, osName, device string) {
	l := strings.ToLower(ua)
	switch {
	case strings.Contains(l, "micromessenger"):
		browser = "微信"
	case strings.Contains(l, "qq/"):
		browser = "QQ"
	case strings.Contains(l, "edg/"):
		browser = "Edge"
	case strings.Contains(l, "opr/") || strings.Contains(l, "opera"):
		browser = "Opera"
	case strings.Contains(l, "firefox/"):
		browser = "Firefox"
	case strings.Contains(l, "chrome/") || strings.Contains(l, "crios/"):
		browser = "Chrome"
	case strings.Contains(l, "safari/"):
		browser = "Safari"
	default:
		browser = "其他"
	}
	switch {
	case strings.Contains(l, "iphone") || strings.Contains(l, "ipad"):
		osName = "iOS"
	case strings.Contains(l, "android"):
		osName = "Android"
	case strings.Contains(l, "windows"):
		osName = "Windows"
	case strings.Contains(l, "mac os"):
		osName = "macOS"
	case strings.Contains(l, "linux"):
		osName = "Linux"
	default:
		osName = "其他"
	}
	switch {
	case strings.Contains(l, "ipad") || strings.Contains(l, "tablet"):
		device = "平板"
	case strings.Contains(l, "mobile") || strings.Contains(l, "iphone") || strings.Contains(l, "android"):
		device = "手机"
	default:
		device = "电脑"
	}
	return
}
