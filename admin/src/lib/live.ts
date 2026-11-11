import { api } from './api'
import { useStore, S } from './store'
import { beep, notify } from './sound'
import { visitorName } from './format'
import { toast } from 'sonner'
import type { Conv, Msg, Row } from './types'

// 页面跳转（哈希路由，和旧版地址保持一致：#/inbox/12）
export function go(p: string) { location.hash = '#/' + p }
const route = () => location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard'

// ---------- 加载数据 ----------
export async function bootstrap() {
  const b = await api('GET', '/api/bootstrap')
  const live: Row = {}
  b.live.forEach((v: Row) => (live[v.id] = v))
  S().set({
    user: b.user, sites: b.sites, users: b.users, canned: b.canned, ai: b.ai, apiURL: b.api_url || location.origin,
    live, sounds: b.sounds || [], soundDefault: b.sound_default || 'turn', plugins: b.plugins || {},
  })
  connectWS()
}
export async function refreshLive() {
  try { const l = await api<Row[]>('GET', '/api/visitors?live=1'); const m: Row = {}; l.forEach(v => (m[v.id] = v)); S().set({ live: m }) } catch { /* 忽略 */ }
}
export async function loadConvs() { try { S().set({ convs: await api('GET', '/api/conversations?filter=open') }) } catch { /* 忽略 */ } }
export async function loadChannels() {
  try { const r = await api('GET', '/api/channels'); S().set({ channels: r.channels, joinable: r.joinable }) } catch { /* 忽略 */ }
}
export async function loadRooms() {
  try { const r = await api('GET', '/api/community/rooms'); S().set({ rooms: r.rooms, community: r }) } catch { /* 忽略 */ }
}
export async function reloadUsers() { try { const b = await api('GET', '/api/bootstrap'); S().set({ users: b.users }) } catch { /* 忽略 */ } }

// ---------- WebSocket ----------
let ws: WebSocket | null = null
let retry = 0
let timer: ReturnType<typeof setTimeout> | null = null

export function connectWS() {
  const { token } = S()
  if (!token || ws) return
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/agent?token=' + encodeURIComponent(token))
  ws.onopen = () => { S().set({ wsOn: true }); retry = 0; refreshLive(); loadConvs(); loadChannels() }
  ws.onclose = () => {
    S().set({ wsOn: false }); ws = null
    if (S().token) timer = setTimeout(connectWS, Math.min(15000, 1000 * Math.pow(2, retry++)))
  }
  ws.onmessage = ev => { try { const e = JSON.parse(ev.data); onEvent(e.type, e.data) } catch (x) { console.error(x) } }
}
export function disconnectWS() {
  if (timer) clearTimeout(timer)
  if (ws) { ws.onclose = null; ws.close(); ws = null }
  S().set({ wsOn: false })
}
export function wsSend(type: string, data: unknown) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data })) }

const typingTimers: Record<number, ReturnType<typeof setTimeout>> = {}

function onEvent(type: string, d: any) {
  const s = S()
  switch (type) {
    case 'visitor_online':
    case 'visitor_update':
      s.set(st => ({
        live: { ...st.live, [d.id]: d },
        convs: type === 'visitor_update'
          ? st.convs.map(c => (c.visitor_id === d.id ? { ...c, online: true, visitor_name: d.name || c.visitor_name, visitor_email: d.email || c.visitor_email } : c))
          : st.convs,
      }))
      break
    case 'visitor_offline':
      s.set(st => {
        const live = { ...st.live }; delete live[d.id]
        const peek = { ...st.peek }; delete peek[d.id]
        return { live, peek, convs: st.convs.map(c => (c.visitor_id === d.id ? { ...c, online: false } : c)) }
      })
      break
    case 'visitor_typing':
      s.set(st => { const peek = { ...st.peek }; if (d.text) peek[d.id] = d.text; else delete peek[d.id]; return { peek } })
      break
    case 'plugins': s.set({ plugins: d || {} }); break
    case 'sounds': s.set({ sounds: d.sounds || [], soundDefault: d.default || 'turn' }); break
    case 'message': {
      const m: Msg = d.message, c: Conv = d.conversation
      s.upsertConv(c)
      if (m.conversation_id === s.openConvId && !s.chatMsgs.some(x => x.id === m.id)) {
        s.set(st => ({ chatMsgs: [...st.chatMsgs, m] }))
        if (m.sender_type === 'visitor' && !document.hidden) api('POST', '/api/conversations/' + m.conversation_id + '/read').catch(() => {})
      }
      if (m.sender_type === 'visitor') {
        s.set(st => { const peek = { ...st.peek }; delete peek[c.visitor_id]; return { peek } })
        const mine = !c.assignee_id || c.assignee_id === s.user?.id
        if (mine && (m.conversation_id !== s.openConvId || document.hidden || route() !== 'inbox'))
          notify('💬 ' + visitorName(c), m.body || '[文件]', () => go('inbox/' + m.conversation_id))
      }
      break
    }
    case 'conversation': s.upsertConv(d); break
    case 'presence': s.set(st => ({ users: st.users.map(u => (u.id === d.user_id ? { ...u, online: d.online } : u)) })); break
    case 'handoff':
      notify('🙋 AI 请求转人工', '有访客需要人工接待', () => go('inbox/' + d.conversation_id))
      toast('AI 请求转人工：会话 #' + d.conversation_id)
      break
    case 'assigned': notify('新的转接会话', d.by + ' 将会话转接给你', () => go('inbox/' + d.conversation_id)); break
    case 'team_message': {
      const open = d.channel_id === s.openChannelId && route() === 'team'
      if (open) {
        if (!s.teamMsgs.some(x => x.id === d.id)) s.set(st => ({ teamMsgs: [...st.teamMsgs, d] }))
        if (!document.hidden) api('POST', '/api/channels/' + d.channel_id + '/read').catch(() => {})
      } else if (d.user_id !== s.user?.id) {
        const c = s.channels.find(x => x.id === d.channel_id)
        if (c && (c.kind === 'dm' || (d.body || '').includes('@' + s.user?.name)))
          notify(c.kind === 'dm' ? '✉️ ' + d.user_name : '# ' + c.name, d.body, () => go('team/' + d.channel_id))
        else beep(true)
      }
      s.set(st => {
        const teamTyping = { ...st.teamTyping }; delete teamTyping[d.channel_id]
        return {
          teamTyping,
          channels: st.channels.map(c => (c.id === d.channel_id
            ? { ...c, last_msg: d.body, last_at: d.created_at, unread: !open && d.user_id !== st.user?.id ? (c.unread || 0) + 1 : c.unread }
            : c)),
        }
      })
      break
    }
    case 'team_typing':
      if (d.user_id !== s.user?.id) {
        s.set(st => ({ teamTyping: { ...st.teamTyping, [d.channel_id]: d.name } }))
        clearTimeout(typingTimers[d.channel_id])
        typingTimers[d.channel_id] = setTimeout(() => s.set(st => { const t = { ...st.teamTyping }; delete t[d.channel_id]; return { teamTyping: t } }), 4000)
      }
      break
    case 'channel_changed': loadChannels(); break
    case 'channel_removed': loadChannels(); if (s.openChannelId === d.id) go('team'); break
    case 'room_message':
      s.set(st => ({
        roomMsgs: d.room_id === st.openRoomId
          ? (st.roomMsgs.some(x => x.id === d.id) ? st.roomMsgs.map(x => (x.id === d.id ? d : x)) : [...st.roomMsgs, d])
          : st.roomMsgs,
        rooms: st.rooms.map(r => (r.id === d.room_id ? { ...r, last_msg: (d.sender_name ? d.sender_name + ': ' : '') + (d.body || '[文件]'), last_at: d.created_at } : r)),
      }))
      break
    case 'room_message_deleted':
      s.set(st => ({ roomMsgs: st.roomMsgs.map(m => (m.id === d.id ? { ...m, deleted: 1, body: '', attachment: null } : m)) }))
      break
    case 'room_updated': case 'room_removed': loadRooms(); break
  }
}

// 标签页标题显示未读数
setInterval(() => {
  const { convs, channels } = S()
  const n = convs.reduce((a, c) => a + (c.unread || 0), 0) + channels.reduce((a, c) => a + (c.unread || 0), 0)
  document.title = (n ? '(' + n + ') ' : '') + 'Koyun Chat 客服工作台'
}, 1000)

export function applyTheme() {
  const t = useStore.getState().theme
  if (t === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
}
