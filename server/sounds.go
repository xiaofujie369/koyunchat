package main

// 系统声音：管理员从本地上传提示音，可以改名、替换文件、删除，并设为默认提示音。
// 文件保存在 uploads/sounds/ 下，通过 /uploads/sounds/xxx 访问。

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const soundSchema = `
CREATE TABLE IF NOT EXISTS sounds(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);`

var soundExt = map[string]bool{".mp3": true, ".m4a": true, ".wav": true, ".ogg": true}

const maxSound = 2 << 20

// builtinSounds 是前端用 WebAudio 合成的三种声音，不能删除
var builtinSounds = map[string]bool{"turn": true, "chime": true, "beep": true}

func registerSoundRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sounds", auth(listSounds))
	mux.HandleFunc("POST /api/sounds", admin(createSound))
	mux.HandleFunc("PUT /api/sounds/{id}", admin(updateSound))
	mux.HandleFunc("DELETE /api/sounds/{id}", admin(deleteSound))
}

func soundList() []M {
	rows, _ := queryMaps(`SELECT id,name,file,size,created_at,updated_at FROM sounds ORDER BY id`)
	for _, r := range rows {
		r["url"] = "/uploads/sounds/" + r["file"].(string)
	}
	return rows
}

// soundDefault 返回系统默认提示音："turn" 等内置名，或 "s:<id>" 表示上传的声音
func soundDefault() string {
	v := getSetting("sound_default", "turn")
	if strings.HasPrefix(v, "s:") {
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM sounds WHERE id=?`, strings.TrimPrefix(v, "s:")).Scan(&n)
		if n == 0 {
			return "turn"
		}
		return v
	}
	if !builtinSounds[v] {
		return "turn"
	}
	return v
}

func listSounds(w http.ResponseWriter, r *http.Request, u *User) {
	writeJSON(w, M{"sounds": soundList(), "default": soundDefault()})
}

// soundsChanged 通知所有在线客服刷新声音列表
func soundsChanged(w http.ResponseWriter, r *http.Request, u *User) {
	hub.broadcastAgents(event("sounds", M{"sounds": soundList(), "default": soundDefault()}))
	listSounds(w, r, u)
}

// readSoundFile 读取表单里的 file 字段并保存，没有文件时返回空字符串
func readSoundFile(w http.ResponseWriter, r *http.Request, required bool) (file string, size int64, errMsg string) {
	f, hdr, err := r.FormFile("file")
	if err != nil {
		if required {
			return "", 0, "请选择声音文件"
		}
		return "", 0, ""
	}
	defer f.Close()
	ext := strings.ToLower(filepath.Ext(hdr.Filename))
	if !soundExt[ext] {
		return "", 0, "只支持 mp3、m4a、wav、ogg 格式"
	}
	if hdr.Size > maxSound {
		return "", 0, "声音文件不能超过 2MB"
	}
	dir := filepath.Join(dataDir, "uploads", "sounds")
	os.MkdirAll(dir, 0o755)
	name := randToken(10) + ext
	out, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		return "", 0, "保存失败"
	}
	defer out.Close()
	n, err := out.ReadFrom(f)
	if err != nil {
		os.Remove(filepath.Join(dir, name))
		return "", 0, "保存失败"
	}
	return name, n, ""
}

func removeSoundFile(file string) {
	if file != "" && !strings.ContainsAny(file, `/\`) {
		os.Remove(filepath.Join(dataDir, "uploads", "sounds", file))
	}
}

func soundName(r *http.Request, fallback string) string {
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = fallback
	}
	return clip(name, 40)
}

func createSound(w http.ResponseWriter, r *http.Request, u *User) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSound+(1<<20))
	file, size, errMsg := readSoundFile(w, r, true)
	if errMsg != "" {
		writeErr(w, 400, errMsg)
		return
	}
	_, hdr, _ := r.FormFile("file")
	fallback := "提示音"
	if hdr != nil {
		fallback = strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename))
	}
	t := now()
	id, err := exec(`INSERT INTO sounds(name,file,size,created_at,updated_at) VALUES(?,?,?,?,?)`, soundName(r, fallback), file, size, t, t)
	if err != nil {
		removeSoundFile(file)
		writeErr(w, 500, "保存失败")
		return
	}
	if r.FormValue("make_default") == "1" {
		setSetting("sound_default", "s:"+strconv.FormatInt(id, 10))
	}
	soundsChanged(w, r, u)
}

func updateSound(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	var oldName, oldFile string
	if db.QueryRow(`SELECT name,file FROM sounds WHERE id=?`, id).Scan(&oldName, &oldFile) != nil {
		writeErr(w, 404, "声音不存在")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSound+(1<<20))
	file, size, errMsg := readSoundFile(w, r, false)
	if errMsg != "" {
		writeErr(w, 400, errMsg)
		return
	}
	name := soundName(r, oldName)
	if file != "" {
		db.Exec(`UPDATE sounds SET name=?,file=?,size=?,updated_at=? WHERE id=?`, name, file, size, now(), id)
		removeSoundFile(oldFile)
	} else {
		db.Exec(`UPDATE sounds SET name=?,updated_at=? WHERE id=?`, name, now(), id)
	}
	soundsChanged(w, r, u)
}

func deleteSound(w http.ResponseWriter, r *http.Request, u *User) {
	id := r.PathValue("id")
	var file string
	if db.QueryRow(`SELECT file FROM sounds WHERE id=?`, id).Scan(&file) != nil {
		writeErr(w, 404, "声音不存在")
		return
	}
	db.Exec(`DELETE FROM sounds WHERE id=?`, id)
	removeSoundFile(file)
	if getSetting("sound_default", "") == "s:"+id {
		setSetting("sound_default", "turn")
	}
	soundsChanged(w, r, u)
}
