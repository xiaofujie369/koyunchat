export type Row = Record<string, any>

const COLORS = ['#7c6bd6', '#2563eb', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#ca8a04']
export function colorOf(s: unknown) {
  const t = String(s ?? '')
  let h = 0
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}
export function initial(n: unknown) { const s = String(n ?? '?').trim(); return (s[0] || '?').toUpperCase() }
export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
// 先转义再加链接，可以安全地用 v-html 显示
export const rich = (s: unknown) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
const pad = (n: number) => String(n).padStart(2, '0')
export const hm = (t: number) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
export function shortTime(t?: number) {
  if (!t) return ''
  const d = new Date(t), n = new Date()
  return d.toDateString() === n.toDateString() ? hm(t) : d.getMonth() + 1 + '/' + d.getDate()
}
export function dayLabel(t: number) {
  const d = new Date(t), n = new Date()
  return d.toDateString() === n.toDateString() ? '今天' : d.getMonth() + 1 + '月' + d.getDate() + '日'
}
export const ls = {
  get(k: string) { try { return localStorage.getItem(k) || '' } catch { return '' } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* 隐私模式 */ } },
  del(k: string) { try { localStorage.removeItem(k) } catch { /* 隐私模式 */ } },
}

// 大照片上传前压缩（GIF 和小图不动）
export function compressImage(file: File): Promise<File> {
  return new Promise(resolve => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return resolve(file)
    const img = new Image(), url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const k = Math.min(1, 1920 / Math.max(img.width, img.height))
      if (k === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file)
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => resolve(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.85)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}
