import type { Row } from './types'

const pad = (n: number) => String(n).padStart(2, '0')
export function fmtTime(ts?: number) {
  if (!ts) return '-'
  const d = new Date(ts), n = new Date()
  if (d.toDateString() === n.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (d.getFullYear() === n.getFullYear()) return d.getMonth() + 1 + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}
export function fmtDur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + '秒'
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60) + '秒'
  return Math.floor(s / 3600) + '时' + Math.floor((s % 3600) / 60) + '分'
}
export function fmtSize(n: number) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}
const COLORS = ['#7c6bd6', '#2563eb', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#ca8a04']
export function colorOf(s: unknown) {
  const t = String(s ?? '')
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]
}
export function visitorName(v?: Row | null) {
  if (!v) return '访客'
  return v.visitor_name || v.name || v.visitor_email || v.email || '访客 #' + String(v.visitor_id || v.id || '').slice(0, 6)
}
export function initial(n: unknown) { const s = String(n ?? '?').trim(); return (s[0] || '?').toUpperCase() }
export function parseExt(e: unknown): Row {
  try { const o = typeof e === 'string' ? JSON.parse(e) : e; return o && typeof o === 'object' ? (o as Row) : {} } catch { return {} }
}
export const EXT_LABEL: Record<string, string> = { email: '邮箱', plan: '套餐', expired_at: '到期', balance: '余额', commission_balance: '佣金', traffic_used: '已用流量', traffic_total: '总流量', traffic_reset_day: '流量重置', banned: '状态', name: '名称' }
export function geoText(v: Row) { return [v.country, v.region, v.city].filter((x, i, a) => x && a.indexOf(x) === i).join(' ') || '-' }
export function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
// 先转义再加链接和 @ 高亮，可以安全地用 dangerouslySetInnerHTML 显示
export function rich(s: unknown) {
  return esc(s)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(@\S+)/g, '$1<b>$2</b>')
}
export async function copyText(t: string) { await navigator.clipboard.writeText(t) }
