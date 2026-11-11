import { create } from 'zustand'
import type { Channel, Conv, Live, Msg, Room, Row, Site, Sound, TeamMsg, User } from './types'

const ls = {
  get(k: string, d = '') { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* 隐私模式 */ } },
  del(k: string) { try { localStorage.removeItem(k) } catch { /* 隐私模式 */ } },
}
export { ls }

export interface State {
  token: string
  user: User | null
  sites: Site[]
  users: User[]
  canned: Row[]
  ai: boolean
  apiURL: string
  live: Record<string, Live>
  peek: Record<string, string>
  convs: Conv[]
  channels: Channel[]
  joinable: Channel[]
  wsOn: boolean
  teamTyping: Record<number, string>
  rooms: Room[]
  community: Row
  sounds: Sound[]
  soundDefault: string
  plugins: Record<string, boolean>
  // 当前打开的会话 / 频道 / 社区群（实时消息只追加到打开的那个）
  openConvId: number
  openChannelId: number
  openRoomId: number
  chatMsgs: Msg[]
  teamMsgs: TeamMsg[]
  roomMsgs: Row[]
  // 本浏览器的个人偏好
  sound: boolean
  soundKind: string
  volume: number
  theme: 'auto' | 'light' | 'dark'

  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void
  login: (token: string) => void
  logout: () => void
  upsertConv: (c?: Conv | null) => void
}

export const useStore = create<State>((set, get) => ({
  token: ls.get('kc_token'),
  user: null, sites: [], users: [], canned: [], ai: false, apiURL: location.origin,
  live: {}, peek: {}, convs: [], channels: [], joinable: [], wsOn: false, teamTyping: {},
  rooms: [], community: {}, sounds: [], soundDefault: 'turn', plugins: {},
  openConvId: 0, openChannelId: 0, openRoomId: 0, chatMsgs: [], teamMsgs: [], roomMsgs: [],
  sound: ls.get('kc_sound') !== '0',
  soundKind: ls.get('kc_sound_kind'),
  volume: parseInt(ls.get('kc_volume', '80')) || 80,
  theme: (ls.get('kc_theme', 'auto') as State['theme']),

  set: p => set(p as any),
  login: token => { ls.set('kc_token', token); set({ token }) },
  logout: () => {
    const t = get().token
    if (t) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {})
    ls.del('kc_token')
    set({ token: '', user: null })
  },
  upsertConv: c => {
    if (!c) return
    set(s => {
      const i = s.convs.findIndex(x => x.id === c.id)
      const list = i >= 0 ? s.convs.map(x => (x.id === c.id ? { ...x, ...c } : x)) : [c, ...s.convs]
      return { convs: [...list].sort((a, b) => b.last_at - a.last_at) }
    })
  },
}))

export const S = () => useStore.getState()
