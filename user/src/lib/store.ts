import { reactive } from 'vue'
import { ls, type Row } from './utils'

// 全局状态（客户端）
export const S = reactive({
  token: ls.get('kc_m_token'),
  me: null as Row | null,
  brand: '社区群聊',
  joined: [] as Row[],
  publicRooms: [] as Row[],
  room: null as Row | null,
  msgs: [] as Row[],
  wsOn: false,
})

export class ApiError extends Error {}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const opt: RequestInit = { method, headers: { Authorization: 'Bearer ' + S.token } }
  if (body instanceof FormData) opt.body = body
  else if (body !== undefined) { opt.body = JSON.stringify(body); (opt.headers as Record<string, string>)['Content-Type'] = 'application/json' }
  const r = await fetch(path, opt)
  let d: any = null
  try { d = await r.json() } catch { /* 空响应 */ }
  if (r.status === 401 && path !== '/api/m/login') { signOut(); throw new ApiError('请重新登录') }
  if (!r.ok) throw new ApiError((d && d.error) || '请求失败')
  return d as T
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function setToken(t: string) { S.token = t; ls.set('kc_m_token', t) }
export function signOut() {
  S.token = ''; S.me = null; ls.del('kc_m_token')
  disconnect()
}

// ---------- 数据 ----------
export async function loadRooms() {
  try {
    const r = await api('GET', '/api/m/rooms')
    S.joined = r.joined; S.publicRooms = r.public
    if (S.room) {
      const cur = S.joined.find(x => x.id === S.room!.id) || S.publicRooms.find(x => x.id === S.room!.id)
      if (cur) S.room = { ...cur, joined: S.joined.some(x => x.id === cur.id) }
    }
  } catch { /* 忽略 */ }
}
export async function reloadMsgs() { if (S.room) try { S.msgs = await api('GET', '/api/m/rooms/' + S.room.id + '/messages') } catch { /* 忽略 */ } }
let readT: ReturnType<typeof setTimeout> | null = null
export function markRead() {
  if (!S.room || !S.room.joined) return
  const id = S.room.id
  if (readT) clearTimeout(readT)
  readT = setTimeout(() => api('POST', '/api/m/rooms/' + id + '/read').catch(() => {}), 400)
  const r = S.joined.find(x => x.id === id); if (r) r.unread = 0
}

// ---------- 实时连接 ----------
let ws: WebSocket | null = null, retry = 0
let onRemoved: ((msg: string) => void) | null = null
export function onRoomRemoved(fn: (msg: string) => void) { onRemoved = fn }
export function connect() {
  if (!S.token || ws) return
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/member?token=' + encodeURIComponent(S.token))
  ws.onopen = () => { S.wsOn = true; retry = 0; loadRooms(); if (S.room) reloadMsgs() }
  ws.onclose = () => { S.wsOn = false; ws = null; if (S.token) setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, retry++))) }
  ws.onmessage = ev => {
    const e = JSON.parse(ev.data), d = e.data
    if (e.type === 'room_message') {
      if (S.room && d.room_id === S.room.id) {
        const i = S.msgs.findIndex(m => m.id === d.id)
        if (i >= 0) S.msgs.splice(i, 1, d); else { S.msgs.push(d); markRead() }
      }
      const r = S.joined.find(x => x.id === d.room_id)
      if (r) {
        r.last_msg = d.deleted ? '消息已删除' : (d.sender_name ? d.sender_name + ': ' : '') + (d.body || '[文件]')
        r.last_at = d.created_at
        const mine = d.sender_kind === 'member' && d.sender_id === S.me?.id
        if (!(S.room && S.room.id === d.room_id) && !mine && d.sender_kind !== 'system') r.unread = (r.unread || 0) + 1
        S.joined.sort((a, b) => b.last_at - a.last_at)
      }
    } else if (e.type === 'room_message_deleted') {
      const m = S.msgs.find(x => x.id === d.id); if (m) { m.deleted = 1; m.body = ''; m.attachment = null }
    } else if (e.type === 'room_updated') {
      loadRooms()
    } else if (e.type === 'room_removed') {
      loadRooms(); if (S.room && S.room.id === d.id) onRemoved?.('你已被移出该群组')
    }
  }
}
export function disconnect() { if (ws) { ws.onclose = null; ws.close(); ws = null } S.wsOn = false }

setInterval(() => {
  const n = S.joined.reduce((a, r) => a + (r.unread || 0), 0)
  document.title = (n ? '(' + n + ') ' : '') + S.brand
}, 1000)
