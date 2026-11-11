import { useStore } from './store'

// 内置三种声音用 WebAudio 合成；管理员上传的提示音（值为 "s:编号"）用 <audio> 播放。
// 个人设置没选过（空字符串）时跟随系统默认。
export const BUILTIN_SOUNDS: [string, string][] = [['turn', '转向灯（嗒-哒，跑车风格）'], ['chime', '叮咚'], ['beep', '简洁“嘀”']]

export function soundLabel(kind: string) {
  const { sounds } = useStore.getState()
  if (kind.startsWith('s:')) return sounds.find(o => 's:' + o.id === kind)?.name ?? '已删除的声音'
  return BUILTIN_SOUNDS.find(o => o[0] === kind)?.[1] ?? kind
}
export function effectiveSound() {
  const { soundKind: k, sounds, soundDefault } = useStore.getState()
  if (k && (!k.startsWith('s:') || sounds.some(o => 's:' + o.id === k))) return k
  return soundDefault || 'turn'
}

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null
const cache: Record<string, HTMLAudioElement> = {}

function out() {
  ctx = ctx || new (window.AudioContext || (window as any).webkitAudioContext)()
  if (ctx.state === 'suspended') ctx.resume()
  const master = ctx.createGain(), comp = ctx.createDynamicsCompressor()
  master.gain.value = (Math.max(0, Math.min(100, useStore.getState().volume)) / 100) * 1.6
  master.connect(comp); comp.connect(ctx.destination)
  return master
}
// 继电器"嗒"声：带通噪声 + 低频，像跑车转向灯
function relay(o: AudioNode, t: number, freq: number, vol: number) {
  const c = ctx!
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate * 0.05, c.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  const n = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain()
  n.buffer = noise; bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 2.2
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.04)
  n.connect(bp); bp.connect(g); g.connect(o); n.start(t); n.stop(t + 0.05)
  const osc = c.createOscillator(), og = c.createGain()
  osc.type = 'triangle'; osc.frequency.setValueAtTime(freq / 6, t); osc.frequency.exponentialRampToValueAtTime(freq / 12, t + 0.03)
  og.gain.setValueAtTime(vol * 0.5, t); og.gain.exponentialRampToValueAtTime(0.0008, t + 0.035)
  osc.connect(og); og.connect(o); osc.start(t); osc.stop(t + 0.04)
}
function tone(o: AudioNode, t: number, freq: number, dur: number, vol: number) {
  const c = ctx!, osc = c.createOscillator(), g = c.createGain()
  osc.type = 'sine'; osc.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g); g.connect(o); osc.start(t); osc.stop(t + dur + 0.02)
}

// soft=true 用于不太紧急的事件（团队群聊），声音短一点
export function playSound(kind?: string, soft = false) {
  kind = kind || effectiveSound()
  if (kind.startsWith('s:')) {
    const x = useStore.getState().sounds.find(o => 's:' + o.id === kind)
    if (x) {
      const url = x.url + '?v=' + x.updated_at
      const a = cache[url] || (cache[url] = new Audio(url))
      a.volume = Math.max(0, Math.min(1, useStore.getState().volume / 100)); a.currentTime = 0
      a.play().catch(() => {})
      return
    }
    kind = 'turn'
  }
  try {
    const o = out(), t = ctx!.currentTime + 0.02
    if (kind === 'turn') {
      for (let i = 0; i < (soft ? 1 : 2); i++) { relay(o, t + i * 0.72, 3400, 1.0); relay(o, t + i * 0.72 + 0.36, 2000, 0.8) }
    } else if (kind === 'chime') {
      tone(o, t, 988, 0.45, 0.5); if (!soft) tone(o, t + 0.22, 784, 0.6, 0.5)
    } else tone(o, t, soft ? 520 : 760, 0.3, 0.45)
  } catch { /* 浏览器不支持 */ }
}
export function beep(soft = false) { if (useStore.getState().sound) playSound(effectiveSound(), soft) }

export function notify(title: string, body: string, onclick?: () => void) {
  beep()
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body: body || '', tag: title })
    n.onclick = () => { window.focus(); onclick?.(); n.close() }
  }
}
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
}, { once: true })
