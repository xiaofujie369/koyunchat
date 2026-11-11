/* Koyun Chat agent console (Vue 3, no build step) */
const { createApp, reactive, computed, ref, watch, nextTick, onMounted, onUnmounted } = Vue;

// ---------------- store & helpers ----------------
const S = reactive({
  token: localStorage.getItem('kc_token') || '',
  user: null, sites: [], users: [], canned: [], ai: false,
  live: {}, peek: {}, convs: [], channels: [], joinable: [],
  wsOn: false, route: { name: 'dashboard', id: '' }, toasts: [], sideOpen: false,
  teamUnread: 0, sound: localStorage.getItem('kc_sound') !== '0',
  theme: localStorage.getItem('kc_theme') || 'auto',
  openConvId: 0, openChannelId: 0, chatMsgs: [], teamMsgs: [], teamTyping: {},
  rooms: [], roomMsgs: [], openRoomId: 0, community: {},
  sounds: [], soundDefault: 'turn', plugins: {},
});

async function api(method, path, body) {
  const opt = { method, headers: { Authorization: 'Bearer ' + S.token } };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (r.status === 401) { logout(); throw new Error('登录已过期'); }
  if (!r.ok) throw new Error((data && data.error) || ('请求失败 ' + r.status));
  return data;
}
function toast(msg, err) {
  const t = { id: Math.random(), msg, err };
  S.toasts.push(t);
  // 按编号移除：放进 S 后取出来的是 Vue 包装过的对象，直接用 !== t 比较永远不相等，提示就不会消失
  setTimeout(() => { S.toasts = S.toasts.filter(x => x.id !== t.id); }, err ? 4500 : 2500);
}
function logout() {
  if (S.token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => {});
  S.token = ''; S.user = null; localStorage.removeItem('kc_token');
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}
const pad = n => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60) + '秒';
  return Math.floor(s / 3600) + '时' + Math.floor((s % 3600) / 60) + '分';
}
const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#ca8a04'];
function colorOf(s) { s = String(s || ''); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
function visitorName(v) {
  if (!v) return '访客';
  return v.visitor_name || v.name || v.visitor_email || v.email || ('访客 #' + String(v.visitor_id || v.id || '').slice(0, 6));
}
function initial(n) { n = String(n || '?').trim(); return (n[0] || '?').toUpperCase(); }
function siteName(id) { const s = S.sites.find(x => x.id === id); return s ? s.name : ''; }
function userName(id) { const u = S.users.find(x => x.id === id); return u ? u.name : ''; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rich(s) { return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/(^|\s)(@\S+)/g, '$1<b>$2</b>'); }
function parseExt(e) { try { const o = typeof e === 'string' ? JSON.parse(e) : e; return o && typeof o === 'object' ? o : {}; } catch (x) { return {}; } }
const EXT_LABEL = { email: '邮箱', plan: '套餐', expired_at: '到期', balance: '余额', commission_balance: '佣金', traffic_used: '已用流量', traffic_total: '总流量', traffic_reset_day: '流量重置', banned: '状态', name: '名称' };
function geoText(v) { return [v.country, v.region, v.city].filter((x, i, a) => x && a.indexOf(x) === i).join(' ') || '-'; }

// ---------------- notifications ----------------
// 内置的三种声音用 WebAudio 合成；管理员上传的提示音（值为 "s:编号"）用 <audio> 播放。
// 个人设置里没选过（空字符串）时跟随系统默认提示音。
S.soundKind = localStorage.getItem('kc_sound_kind') || '';
S.volume = parseInt(localStorage.getItem('kc_volume') || '80');
const SOUNDS = [['turn', '转向灯（嗒-哒，跑车风格）'], ['chime', '叮咚'], ['beep', '简洁“嘀”']];
let audioCtx = null, noiseBuf = null;
function audioOut() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  // master volume -> compressor keeps loud settings from clipping
  const master = audioCtx.createGain(), comp = audioCtx.createDynamicsCompressor();
  master.gain.value = Math.max(0, Math.min(100, S.volume)) / 100 * 1.6;
  master.connect(comp); comp.connect(audioCtx.destination);
  return master;
}
// one relay "tick": a band-passed noise burst plus a short low thump, like a car's flasher relay
function relayClick(out, t, freq, vol) {
  if (!noiseBuf) {
    noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.05, audioCtx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const n = audioCtx.createBufferSource(), bp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  n.buffer = noiseBuf; bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 2.2;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.04);
  n.connect(bp); bp.connect(g); g.connect(out); n.start(t); n.stop(t + 0.05);
  const o = audioCtx.createOscillator(), og = audioCtx.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(freq / 6, t); o.frequency.exponentialRampToValueAtTime(freq / 12, t + 0.03);
  og.gain.setValueAtTime(vol * 0.5, t); og.gain.exponentialRampToValueAtTime(0.0008, t + 0.035);
  o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.04);
}
function tone(out, t, freq, dur, vol) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
}
function soundLabel(kind) {
  if (String(kind).startsWith('s:')) { const x = S.sounds.find(o => 's:' + o.id === kind); return x ? x.name : '已删除的声音'; }
  const b = SOUNDS.find(o => o[0] === kind); return b ? b[1] : kind;
}
// 实际要播放的声音：个人选择优先；选的上传声音被删除了就退回系统默认
function effectiveSound() {
  const k = S.soundKind;
  if (k && (!k.startsWith('s:') || S.sounds.some(o => 's:' + o.id === k))) return k;
  return S.soundDefault || 'turn';
}
const audioCache = {};
function playFile(url) {
  const a = audioCache[url] || (audioCache[url] = new Audio(url));
  a.volume = Math.max(0, Math.min(1, S.volume / 100));
  a.currentTime = 0;
  const p = a.play(); if (p && p.catch) p.catch(() => {});
}
// kind: sound style; soft=true for less urgent events (team chat) — plays a shorter pattern
function playSound(kind, soft) {
  kind = kind || effectiveSound();
  if (String(kind).startsWith('s:')) {
    const x = S.sounds.find(o => 's:' + o.id === kind);
    if (x) return playFile(x.url + '?v=' + x.updated_at);
    kind = 'turn';
  }
  try {
    const out = audioOut(), t = audioCtx.currentTime + 0.02;
    if (kind === 'turn') {
      const cycles = soft ? 1 : 2;
      for (let i = 0; i < cycles; i++) {
        relayClick(out, t + i * 0.72, 3400, 1.0);        // 嗒 (relay closes)
        relayClick(out, t + i * 0.72 + 0.36, 2000, 0.8); // 哒 (relay opens)
      }
    } else if (kind === 'chime') {
      tone(out, t, 988, 0.45, 0.5); if (!soft) tone(out, t + 0.22, 784, 0.6, 0.5);
    } else {
      tone(out, t, soft ? 520 : 760, 0.3, 0.45);
    }
  } catch (e) {}
}
function beep(freq) {
  if (!S.sound) return;
  playSound(effectiveSound(), !!freq);
}
function notify(title, body, onclick) {
  beep();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body: body || '', tag: title });
    n.onclick = () => { window.focus(); onclick && onclick(); n.close(); };
  }
}
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

// ---------------- websocket ----------------
let ws = null, wsRetry = 0;
function connectWS() {
  if (!S.token) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/agent?token=' + encodeURIComponent(S.token));
  ws.onopen = () => { S.wsOn = true; wsRetry = 0; refreshLive(); loadConvs(); loadChannels(); };
  ws.onclose = () => { S.wsOn = false; ws = null; setTimeout(connectWS, Math.min(15000, 1000 * Math.pow(2, wsRetry++))); };
  ws.onmessage = ev => { try { const e = JSON.parse(ev.data); onEvent(e.type, e.data); } catch (x) { console.error(x); } };
}
function wsSend(type, data) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data })); }

function upsertConv(c) {
  if (!c) return;
  const i = S.convs.findIndex(x => x.id === c.id);
  if (i >= 0) S.convs.splice(i, 1, Object.assign({}, S.convs[i], c));
  else S.convs.unshift(c);
  S.convs.sort((a, b) => b.last_at - a.last_at);
}

function onEvent(type, d) {
  switch (type) {
    case 'visitor_online':
      S.live[d.id] = d;
      break;
    case 'visitor_update':
      S.live[d.id] = d;
      S.convs.forEach(c => { if (c.visitor_id === d.id) { c.online = true; if (d.name) c.visitor_name = d.name; if (d.email) c.visitor_email = d.email; } });
      break;
    case 'visitor_offline':
      delete S.live[d.id]; delete S.peek[d.id];
      S.convs.forEach(c => { if (c.visitor_id === d.id) c.online = false; });
      break;
    case 'visitor_typing':
      if (d.text) S.peek[d.id] = d.text; else delete S.peek[d.id];
      break;
    case 'plugins': S.plugins = d || {}; break;
    case 'sounds': S.sounds = d.sounds || []; S.soundDefault = d.default || 'turn'; break;
    case 'message': {
      const m = d.message;
      upsertConv(d.conversation);
      if (m.conversation_id === S.openConvId && !S.chatMsgs.some(x => x.id === m.id)) {
        S.chatMsgs.push(m);
        if (m.sender_type === 'visitor' && !document.hidden) api('POST', '/api/conversations/' + m.conversation_id + '/read').catch(() => {});
      }
      if (m.sender_type === 'visitor') {
        delete S.peek[d.conversation.visitor_id];
        const mine = !d.conversation.assignee_id || d.conversation.assignee_id === S.user.id;
        if (mine && (m.conversation_id !== S.openConvId || document.hidden || S.route.name !== 'inbox'))
          notify('💬 ' + visitorName(d.conversation), m.body || '[文件]', () => go('inbox/' + m.conversation_id));
      }
      break;
    }
    case 'conversation': upsertConv(d); break;
    case 'presence': { const u = S.users.find(x => x.id === d.user_id); if (u) u.online = d.online; break; }
    case 'handoff': notify('🙋 AI 请求转人工', '有访客需要人工接待', () => go('inbox/' + d.conversation_id)); toast('AI 请求转人工：会话 #' + d.conversation_id); break;
    case 'assigned': notify('新的转接会话', d.by + ' 将会话转接给你', () => go('inbox/' + d.conversation_id)); break;
    case 'team_message': {
      if (d.channel_id === S.openChannelId && S.route.name === 'team') {
        if (!S.teamMsgs.some(x => x.id === d.id)) S.teamMsgs.push(d);
        if (!document.hidden) api('POST', '/api/channels/' + d.channel_id + '/read').catch(() => {});
      } else if (d.user_id !== S.user.id) {
        const c = S.channels.find(x => x.id === d.channel_id);
        if (c) c.unread = (c.unread || 0) + 1;
        if (c && (c.kind === 'dm' || (d.body || '').includes('@' + S.user.name)))
          notify(c.kind === 'dm' ? '✉️ ' + d.user_name : '# ' + c.name, d.body, () => go('team/' + d.channel_id));
        else beep(520);
      }
      const c = S.channels.find(x => x.id === d.channel_id);
      if (c) { c.last_msg = d.body; c.last_at = d.created_at; }
      delete S.teamTyping[d.channel_id];
      break;
    }
    case 'team_typing':
      if (d.user_id !== S.user.id) { S.teamTyping[d.channel_id] = d.name; setTimeout(() => { if (S.teamTyping[d.channel_id] === d.name) delete S.teamTyping[d.channel_id]; }, 4000); }
      break;
    case 'channel_changed': loadChannels(); break;
    case 'channel_removed': loadChannels(); if (S.openChannelId === d.id) go('team'); break;
    case 'room_message': {
      if (d.room_id === S.openRoomId) { const i = S.roomMsgs.findIndex(x => x.id === d.id); if (i >= 0) S.roomMsgs.splice(i, 1, d); else S.roomMsgs.push(d); }
      const r = S.rooms.find(x => x.id === d.room_id);
      if (r) { r.last_msg = (d.sender_name ? d.sender_name + ': ' : '') + (d.body || '[文件]'); r.last_at = d.created_at; }
      break;
    }
    case 'room_message_deleted': { const m = S.roomMsgs.find(x => x.id === d.id); if (m) { m.deleted = 1; m.body = ''; m.attachment = null; } break; }
    case 'room_updated': case 'room_removed': loadRooms(); break;
  }
}

async function bootstrap() {
  const b = await api('GET', '/api/bootstrap');
  S.user = b.user; S.sites = b.sites; S.users = b.users; S.canned = b.canned; S.ai = b.ai; S.apiURL = b.api_url || location.origin;
  S.live = {}; b.live.forEach(v => S.live[v.id] = v);
  S.sounds = b.sounds || []; S.soundDefault = b.sound_default || 'turn'; S.plugins = b.plugins || {};
  connectWS();
}
async function refreshLive() {
  try { const l = await api('GET', '/api/visitors?live=1'); const m = {}; l.forEach(v => m[v.id] = v); S.live = m; } catch (e) {}
}
async function loadConvs() {
  try { S.convs = await api('GET', '/api/conversations?filter=open'); } catch (e) {}
}
async function loadRooms() {
  try { const r = await api('GET', '/api/community/rooms'); S.rooms = r.rooms; S.community = r; } catch (e) {}
}
async function loadChannels() {
  try { const r = await api('GET', '/api/channels'); S.channels = r.channels; S.joinable = r.joinable; } catch (e) {}
}

// ---------------- router ----------------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  S.route = { name: name || 'dashboard', id: id || '' };
  S.sideOpen = false;
}
function go(p) { location.hash = '#/' + p; }
window.addEventListener('hashchange', parseRoute);
parseRoute();

// title badge
setInterval(() => {
  const n = S.convs.reduce((a, c) => a + (c.unread || 0), 0) + S.channels.reduce((a, c) => a + (c.unread || 0), 0);
  document.title = (n ? '(' + n + ') ' : '') + 'Koyun Chat 客服工作台';
}, 1000);

function applyTheme() {
  if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', S.theme);
}
applyTheme();

const EMOJI = [
  ['常用', '😀 😂 🤣 😊 😍 🥰 😘 😎 🤔 😅 😭 😡 👍 👎 👏 🙏 💪 🎉 ❤️ 🔥 ✅ ❌ 👌 🙌 😉 😆 🤝 💯 🌹 😱'],
  ['笑脸', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖'],
  ['手势', '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪'],
  ['爱心', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 😻 🌹 💐'],
  ['动物', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐬 🐳 🐟 🐠 🦈'],
  ['食物', '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥝 🍅 🥑 🌽 🥕 🍞 🧀 🍗 🍖 🍔 🍟 🍕 🌭 🌮 🍜 🍣 🍤 🍙 🍚 🍰 🎂 🍦 🍩 🍪 🍫 🍬 🍭 ☕ 🍵 🍺 🍻 🥂 🍷 🥤 🧋'],
  ['物品', '🎉 🎊 🎁 🎈 🏆 🥇 ⚽ 🏀 🎮 🎧 🎵 📱 💻 ⌨️ 🖥️ 📷 💡 🔑 🔒 🔓 💰 💎 📦 📌 📎 ✂️ 📝 📅 ⏰ ⌛ 🚀 ✈️ 🚗 🏠 🌈 ☀️ 🌙 ⭐ 🌟 ⚡ 🔥 💧 🌸 🍀'],
  ['符号', '✅ ❌ ⭕ ❗ ❓ ‼️ ⁉️ 💯 🔴 🟢 🔵 ⚠️ 🚫 🆗 🆕 🆙 🔝 ➡️ ⬅️ ⬆️ ⬇️ 🔄 ➕ ➖ ✖️ 💲 ©️ ®️ ™️'],
].map(([name, list]) => [name, list.split(' ')]);

// shrink large photos before upload (keeps GIFs and small images untouched)
function compressImage(file) {
  return new Promise(resolve => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return resolve(file);
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1920, k = Math.min(1, max / Math.max(img.width, img.height));
      if (k === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => resolve(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// insert text at the caret of a textarea bound with v-model (returns the new value)
// noFocus: on phones, keep the keyboard closed so it does not cover the emoji panel
function insertAt(ta, value, text, noFocus) {
  if (!ta) return value + text;
  const s = ta.selectionStart ?? value.length, e = ta.selectionEnd ?? value.length;
  const v = value.slice(0, s) + text + value.slice(e);
  requestAnimationFrame(() => { if (!noFocus) ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length; });
  return v;
}

// ---------------- shared components ----------------
const EmojiPop = {
  emits: ['pick'],
  template: `<div class="pop emoji-pop" @mousedown.prevent>
    <div class="etabs"><a v-for="(g,i) in EMOJI" :key="g[0]" :class="{on:tab===i}" @click="tab=i">{{g[0]}}</a></div>
    <div class="egrid"><span v-for="e in EMOJI[tab][1]" :key="e" @click="$emit('pick', e)">{{e}}</span></div></div>`,
  data: () => ({ EMOJI, tab: 0 }),
};
const Avatar = {
  props: { name: null, online: null, small: Boolean, seed: null },
  template: `<div class="av" :class="{s:small}" :style="{background:color}">{{ini}}<span v-if="online!==undefined" class="dot" :class="{on:online}"></span></div>`,
  computed: { ini() { return initial(this.name); }, color() { return colorOf(this.seed || this.name); } },
};

const Modal = {
  props: ['title', 'lg'],
  emits: ['close'],
  template: `<div class="mask" @mousedown.self="$emit('close')"><div class="modal" :class="{lg}"><div class="mh">{{title}}<span class="x" @click="$emit('close')">×</span></div><div class="mb"><slot/></div><div class="mf" v-if="$slots.foot"><slot name="foot"/></div></div></div>`,
};

const Attachment = {
  props: ['a'],
  template: `<template v-if="a && a.url"><img v-if="(a.type||'').startsWith('image/')" :src="a.url" @click="open"><a v-else :href="a.url" target="_blank" rel="noopener" class="filelink"><Icon n="doc" :s="18"/>{{a.name||'文件'}}</a></template>`,
  methods: { open() { window.open(this.a.url, '_blank'); } },
};

async function uploadFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('文件不能超过 20MB');
  const fd = new FormData(); fd.append('file', await compressImage(file));
  return api('POST', '/api/upload', fd);
}

// ---------------- views ----------------
const Login = {
  template: `<div class="login"><div class="card">
    <div class="logo"><Icon n="chat" :s="30" :w="2"/></div>
    <h2>Koyun Chat</h2><p class="muted" style="margin:0 0 28px">登录客服工作台</p>
    <form @submit.prevent="submit">
      <div class="field"><label>邮箱</label><input class="inp" v-model="email" autocomplete="username" required></div>
      <div class="field"><label>密码</label><input class="inp" type="password" v-model="password" autocomplete="current-password" required></div>
      <button class="btn pri" style="width:100%;height:44px;font-size:15px;margin-top:6px" :disabled="busy">{{busy?'登录中…':'登录'}}</button>
    </form></div></div>`,
  data: () => ({ email: '', password: '', busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      try {
        const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: this.email, password: this.password }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        S.token = d.token; localStorage.setItem('kc_token', d.token);
        await bootstrap();
      } catch (e) { toast(e.message, true); }
      this.busy = false;
    },
  },
};

const Dashboard = {
  components: { Avatar },
  template: `<div>
    <div class="grid g4">
      <div class="card card-b stat"><div class="k">在线访客</div><div class="v">{{liveCount}}</div><div class="s">实时</div></div>
      <div class="card card-b stat"><div class="k">进行中会话</div><div class="v">{{st.open||0}}</div><div class="s">未分配 {{st.unassigned||0}}</div></div>
      <div class="card card-b stat"><div class="k">今日会话</div><div class="v">{{st.today_conversations||0}}</div><div class="s">消息 {{st.today_messages||0}} · AI 回复 {{st.today_ai||0}}</div></div>
      <div class="card card-b stat"><div class="k">满意度</div><div class="v">{{st.avg_rating?st.avg_rating.toFixed(1):'-'}}</div><div class="s">在线客服 {{onlineAgents.length}} 人</div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-h">近 7 天 <span class="sp" style="flex:1"></span><span class="small muted"><span class="tag blue">会话</span> <span class="tag">访客</span></span></div>
        <div class="card-b"><div class="bars">
          <div class="bc" v-for="d in st.days||[]" :key="d.date">
            <div class="bw"><div class="bar" :style="{height:h(d.conversations)}" :title="'会话 '+d.conversations"></div><div class="bar b2" :style="{height:h(d.visitors)}" :title="'访客 '+d.visitors"></div></div>
            <div class="lb">{{d.date}}</div></div>
        </div></div></div>
      <div class="card"><div class="card-h">团队成员</div><div class="card-b">
        <div v-for="u in S.users" :key="u.id" class="row" style="margin-bottom:10px">
          <Avatar :name="u.name" :online="u.online" small /><div style="flex:1"><div>{{u.name}} <span class="tag" v-if="u.role==='admin'">管理员</span></div><div class="small muted">{{u.email}}</div></div>
          <span class="small" :class="u.online?'':'muted'">{{u.online?'在线':'离线'}}</span></div>
      </div></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h">接入指引</div><div class="card-b small">
      <ol style="margin:0;padding-left:18px;line-height:2">
        <li>在 <a href="#/sites">站点管理</a> 创建站点，复制嵌入代码，放到网站页面的 &lt;/body&gt; 前（Xboard：后台 → 主题配置 → 自定义页脚 HTML）。</li>
        <li>在 <a href="#/settings">系统设置</a> 填入 Claude API Key，即可使用 AI 自动接待、回复建议、润色翻译和会话总结。</li>
        <li>在 <a href="#/agents">客服成员</a> 添加同事账号，在 <a href="#/team">团队协作</a> 里建立私人群组、私信沟通；群聊里 @AI 可以召唤 AI 助手。</li>
      </ol></div></div>
  </div>`,
  data: () => ({ st: {}, S }),
  computed: {
    liveCount() { return Object.keys(S.live).length; },
    onlineAgents() { return S.users.filter(u => u.online); },
    maxV() { return Math.max(1, ...(this.st.days || []).map(d => Math.max(d.conversations, d.visitors))); },
  },
  methods: { h(v) { return (v / this.maxV * 100) + '%'; } },
  async mounted() { try { this.st = await api('GET', '/api/stats'); } catch (e) { toast(e.message, true); } },
};

const Visitors = {
  components: { Avatar },
  template: `<div>
    <div class="card"><div class="card-h">实时访客 <span class="tag green">{{list.length}} 人在线</span>
      <span style="flex:1"></span>
      <select class="inp" style="width:160px" v-model="site"><option value="0">全部站点</option><option v-for="s in S.sites" :value="s.id">{{s.name}}</option></select>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>访客</th><th>当前页面</th><th>位置 / IP</th><th>设备</th><th>本次停留</th><th>页数</th><th>站点</th><th></th></tr></thead>
      <tbody>
        <tr v-for="v in list" :key="v.id">
          <td><div class="row"><Avatar :name="vn(v)" :seed="v.id" :online="true" small /><div><div style="font-weight:500">{{vn(v)}}</div>
            <div class="small muted" v-if="ext(v).plan">{{ext(v).plan}} · 到期 {{ext(v).expired_at}}</div>
            <div class="small" v-if="S.peek[v.id]" style="color:var(--warn)">正在输入：{{S.peek[v.id]}}</div></div></div></td>
          <td style="max-width:280px"><div class="ell" :title="v.title">{{v.title||'-'}}</div><a class="small ell" style="display:block" :href="v.url" target="_blank" rel="noopener" :title="v.url">{{v.url}}</a>
            <div class="small muted">停留 {{dur(v.page_since||v.connected_at)}}</div></td>
          <td><div>{{geo(v)}}</div><div class="small muted">{{v.ip}}</div></td>
          <td class="small">{{v.device}} · {{v.os}}<br><span class="muted">{{v.browser}}</span></td>
          <td class="small">{{dur(v.connected_at)}}<div class="muted">第 {{v.visits}} 次访问</div></td>
          <td>{{v.pages}}</td>
          <td><span class="tag">{{siteName(v.site_id)}}</span></td>
          <td><button class="btn sm" :class="v.chatting?'':'pri'" @click="chat(v)">{{v.chatting?'查看会话':'发起对话'}}</button></td>
        </tr>
        <tr v-if="!list.length"><td colspan="8" class="empty">暂无在线访客</td></tr>
      </tbody></table></div></div>
  </div>`,
  data: () => ({ S, site: '0', tick: 0, t: null }),
  computed: {
    list() { this.tick; return Object.values(S.live).filter(v => this.site === '0' || String(v.site_id) === String(this.site)).sort((a, b) => b.connected_at - a.connected_at); },
  },
  methods: {
    siteName, vn: visitorName, ext: v => parseExt(v.ext), geo: geoText,
    dur(t) { this.tick; return fmtDur(Date.now() - t); },
    async chat(v) {
      if (v.conversation_id) return go('inbox/' + v.conversation_id);
      try { const r = await api('POST', '/api/visitors/' + v.id + '/chat'); go('inbox/' + r.id); } catch (e) { toast(e.message, true); }
    },
  },
  mounted() { this.t = setInterval(() => this.tick++, 1000); },
  unmounted() { clearInterval(this.t); },
};

const VisitorPanel = {
  components: { Avatar, MailCompose: null },
  props: ['v', 'conv'],
  emits: ['changed'],
  template: `<div v-if="v">
    <div class="info-s" style="text-align:center">
      <div style="display:flex;justify-content:center"><Avatar :name="name" :seed="v.id" :online="!!v.live" /></div>
      <div style="font-weight:600;margin-top:8px">{{name}}</div>
      <div class="small muted">{{v.live ? '在线 · 已停留 ' + dur(v.live.connected_at) : '离线 · 最后访问 ' + fmtTime(v.last_seen)}}</div>
    </div>
    <div class="info-s" v-if="v.live"><h4>正在浏览</h4>
      <div class="small" style="font-weight:500">{{v.live.title||'-'}}</div>
      <a class="small" style="word-break:break-all" :href="v.live.url" target="_blank" rel="noopener">{{v.live.url}}</a>
      <div class="small muted">此页停留 {{dur(v.live.page_since||v.live.connected_at)}}</div>
    </div>
    <div class="info-s" v-if="Object.keys(ext).length"><h4>站点账户 <span class="tag amber" title="由访客浏览器上报，仅供参考">浏览器上报</span></h4>
      <div class="kv"><template v-for="(val,k) in ext" :key="k"><div class="k">{{EXT_LABEL[k]||k}}</div><div class="v">{{val}}</div></template></div>
    </div>
    <div class="info-s"><h4>访客资料</h4>
      <div class="field"><input class="inp" v-model="form.name" placeholder="称呼" @change="save"></div>
      <div class="field"><input class="inp" v-model="form.email" placeholder="邮箱 / 联系方式" @change="save"></div>
      <div class="kv">
        <div class="k">IP</div><div class="v">{{v.ip}}</div>
        <div class="k">位置</div><div class="v">{{geo}}</div>
        <div class="k">设备</div><div class="v">{{v.device}} · {{v.os}} · {{v.browser}}</div>
        <div class="k">语言</div><div class="v">{{v.lang||'-'}}</div>
        <div class="k">访问次数</div><div class="v">{{v.visits}}</div>
        <div class="k">首次访问</div><div class="v">{{fmtTime(v.first_seen)}}</div>
        <div class="k">来源</div><div class="v">{{v.referrer||'直接访问'}}</div>
      </div>
    </div>
    <div class="info-s"><h4>备注</h4><textarea class="inp" v-model="form.notes" placeholder="仅客服可见" @change="save" style="min-height:60px"></textarea></div>
    <div class="info-s"><h4>浏览轨迹</h4><div class="trail">
      <div v-for="p in v.pages" :key="p.ts"><div class="ell" :title="p.url"><a :href="p.url" target="_blank" rel="noopener">{{p.title||p.url}}</a></div><div class="muted">{{fmtTime(p.ts)}}</div></div>
      <div v-if="!v.pages.length" class="muted">无</div></div></div>
    <div class="info-s" v-if="v.conversations.length>1"><h4>历史会话</h4><div class="trail">
      <div v-for="c in v.conversations" :key="c.id"><a :href="'#/inbox/'+c.id">#{{c.id}}</a> <span class="tag" :class="c.status==='open'?'green':''">{{c.status==='open'?'进行中':'已结束'}}</span> <span class="muted">{{fmtTime(c.last_at)}}</span><div class="ell muted">{{c.last_msg}}</div></div></div></div>
    <div class="info-s" v-if="S.plugins.mail"><h4>邮件 <span class="tag" v-if="!v.live">客户离线</span></h4>
      <button class="btn sm" @click="mailOpen=true">✉️ 发送邮件</button>
      <div class="trail" v-if="mails.length" style="margin-top:8px">
        <div v-for="l in mails" :key="l.id"><div class="ell" :title="l.body">{{l.subject}}</div>
          <div class="muted">{{fmtTime(l.created_at)}} · {{l.to_addr}} · {{l.status==='ok'?'已发送':'失败'}}</div></div></div>
    </div>
    <div class="info-s"><button class="btn sm dan" @click="block">{{v.blocked?'解除屏蔽':'屏蔽访客'}}</button></div>
    <MailCompose v-if="mailOpen" :to="mailTo" :name="form.name" :visitor-id="v.id" :conv-id="conv && conv.id" @close="mailOpen=false" @sent="loadMails" />
  </div>`,
  data() { return { S, form: { name: '', email: '', notes: '' }, tick: 0, t: null, EXT_LABEL, mailOpen: false, mails: [] }; },
  computed: {
    name() { return this.form.name || this.v.email || visitorName(this.v); },
    ext() { return parseExt(this.v.live ? this.v.live.ext : this.v.ext); },
    geo() { return geoText(this.v); },
    mailTo() { const e = this.form.email || this.ext.email || ''; return /@/.test(e) ? e.trim() : ''; },
  },
  watch: {
    v: { immediate: true, handler(v) { if (v) { this.form = { name: v.name, email: v.email, notes: v.notes }; this.loadMails(); } } },
    'S.plugins.mail'() { this.loadMails(); },
  },
  methods: {
    fmtTime,
    async loadMails() {
      this.mails = [];
      if (!this.v || !S.plugins.mail) return;
      try { this.mails = await api('GET', '/api/mail/logs?visitor_id=' + encodeURIComponent(this.v.id)); } catch (e) {}
    },
    dur(t) { this.tick; return fmtDur(Date.now() - t); },
    async save() {
      try { await api('PUT', '/api/visitors/' + this.v.id, this.form); toast('已保存'); this.$emit('changed'); } catch (e) { toast(e.message, true); }
    },
    async block() {
      if (!this.v.blocked && !confirm('屏蔽后该访客将无法再连接客服，确定？')) return;
      try { await api('PUT', '/api/visitors/' + this.v.id, { blocked: !this.v.blocked }); this.$emit('changed'); } catch (e) { toast(e.message, true); }
    },
  },
  mounted() { this.t = setInterval(() => this.tick++, 1000); },
  unmounted() { clearInterval(this.t); },
};

const Inbox = {
  components: { Avatar, VisitorPanel, Attachment, EmojiPop },
  template: `<div class="content flush" :class="{'has-chat':!!conv}" style="flex:1">
    <div class="col col-list">
      <div style="padding:10px 10px 0" class="row">
        <input class="inp" v-model="q" placeholder="搜索访客 / 邮箱 / IP / 消息" @keyup.enter="load">
        <select class="inp" style="width:110px" v-model="site" @change="load"><option value="0">全部站点</option><option v-for="s in S.sites" :value="s.id">{{s.name}}</option></select>
      </div>
      <div class="tabs"><a v-for="t in tabs" :key="t[0]" :class="{on:filter===t[0]}" @click="filter=t[0];load()">{{t[1]}}<span v-if="t[0]==='open'&&unreadTotal" class="ub" style="margin-left:4px">{{unreadTotal}}</span></a></div>
      <div class="list">
        <div v-for="c in list" :key="c.id" class="item" :class="{on:conv&&conv.id===c.id}" @click="go('inbox/'+c.id)">
          <Avatar :name="vn(c)" :seed="c.visitor_id" :online="!!c.online" />
          <div class="b"><div class="l1"><span class="nm">{{vn(c)}}</span><span class="tm">{{fmtTime(c.last_at)}}</span></div>
            <div class="l2"><span class="ell">{{S.peek[c.visitor_id] ? '正在输入：'+S.peek[c.visitor_id] : (c.last_msg||'新会话')}}</span><span v-if="c.unread" class="ub">{{c.unread}}</span></div>
            <div class="l2"><span class="tag">{{c.site_name}}</span><span class="tag" v-if="c.assignee_name">{{c.assignee_name}}</span><span class="tag amber" v-else-if="c.status==='open'">未分配</span>
              <span class="tag purple" v-if="c.status==='open'&&!c.ai_paused&&aiSite(c.site_id)">AI 接待</span><span v-if="c.rating" class="tag">{{'★'.repeat(c.rating)}}</span></div></div>
        </div>
        <div v-if="!list.length" class="empty">暂无会话</div>
      </div>
    </div>
    <div class="col col-chat" v-if="conv">
      <div class="chat-h">
        <button class="btn sm ghost mob-only" @click="go('inbox')"><Icon n="back"/></button>
        <Avatar :name="vn(conv)" :seed="conv.visitor_id" :online="!!conv.online" />
        <div class="t"><div style="font-weight:600" class="ell">{{vn(conv)}} <span class="tag">{{conv.site_name}}</span></div>
          <div class="small muted ell">{{live ? '正在浏览：' + (live.title||live.url) : '访客已离线'}}</div></div>
        <span v-if="aiSite(conv.site_id) && conv.status==='open'" class="row small" style="gap:6px" title="开启后 AI 会自动回复访客；客服回复后自动暂停">
          AI 接待 <span class="switch" :class="{on:!conv.ai_paused}" @click="toggleAI"></span></span>
        <select class="inp" style="width:120px" :value="conv.assignee_id" @change="assign($event.target.value)">
          <option :value="0">未分配</option><option v-for="u in S.users" :value="u.id">{{u.name}}{{u.online?'':'（离线）'}}</option></select>
        <button class="btn sm" v-if="conv.status==='open'" @click="setStatus('closed')">结束会话</button>
        <button class="btn sm" v-else @click="setStatus('open')">重新打开</button>
      </div>
      <div class="msgs" ref="msgs">
        <div v-for="m in S.chatMsgs" :key="m.id" class="m" :class="cls(m)">
          <div><div class="bb"><span v-if="m.sender_type==='note'" class="small" style="font-weight:600;color:#c93400">内部备注 · </span><span v-html="rich(m.body)"></span><Attachment :a="m.attachment"/></div>
            <div class="meta" v-if="m.sender_type!=='system'">{{who(m)}} · {{fmtTime(m.created_at)}}</div></div>
        </div>
      </div>
      <div class="peek" v-if="S.peek[conv.visitor_id]"><Icon n="note" :s="16"/><span>访客正在输入：{{S.peek[conv.visitor_id]}}</span></div>
      <div class="ai-box" v-if="aiText"><div class="h"><Icon n="sparkles" :s="18"/> {{aiTitle}} <span style="flex:1"></span>
        <button class="btn sm" v-if="aiKind==='suggest'" @click="useAI">使用</button><button class="btn sm ghost" @click="aiText=''">关闭</button></div>{{aiText}}</div>
      <div class="composer" :class="{note:mode==='note'}">
        <div class="pop" v-if="cannedOpen && cannedList.length" style="bottom:100%;left:12px;margin-bottom:4px;width:360px">
          <a v-for="(c,i) in cannedList" :key="c.id" :class="{on:i===cannedIdx}" @mousedown.prevent="useCanned(c)"><b>/{{c.shortcut}}</b> <span class="muted">{{c.body.slice(0,60)}}</span></a></div>
        <div class="pop" v-if="rewriteOpen" style="bottom:100%;right:12px;margin-bottom:4px">
          <a v-for="r in rewrites" :key="r[0]" @mousedown.prevent="rewrite(r[0])">{{r[1]}}</a></div>
        <textarea ref="ta" v-model="text" :placeholder="mode==='note'?'内部备注，访客看不到…':'输入回复，Enter 发送，Shift+Enter 换行，/ 快捷回复'" @keydown="keydown" @input="onInput" @paste="paste"></textarea>
        <div class="tools">
          <div class="mode"><a :class="{on:mode==='reply'}" @click="mode='reply'">回复</a><a :class="{on:mode==='note'}" @click="mode='note'">备注</a></div>
          <button class="btn sm ghost" title="表情" @click="emojiOpen=!emojiOpen"><Icon n="smile"/></button>
          <button class="btn sm ghost" title="发图片" @click="$refs.img.click()"><Icon n="photo"/></button>
          <button class="btn sm ghost" title="发送文件" @click="$refs.file.click()"><Icon n="clip"/></button>
          <button class="btn sm ghost" title="快捷回复" @click="text='/';onInput();$refs.ta.focus()"><Icon n="bolt"/></button>
          <template v-if="S.ai">
            <button class="btn sm ghost" :disabled="aiBusy" @click="suggest" title="AI 根据对话和知识库起草回复（可先在输入框写要点）"><Icon n="sparkles" :s="18"/>AI 建议</button>
            <button class="btn sm ghost" :disabled="aiBusy" @click="rewriteOpen=!rewriteOpen"><Icon n="wand" :s="18"/>润色/翻译</button>
            <button class="btn sm ghost" :disabled="aiBusy" @click="summarize"><Icon n="doc" :s="18"/>总结</button>
            <span v-if="aiBusy" class="small muted">AI 思考中…</span>
          </template>
          <span style="flex:1"></span>
          <button class="btn pri sm" @click="send" :disabled="sending">发送</button>
          <input type="file" ref="file" style="display:none" @change="pickFile">
          <input type="file" ref="img" accept="image/*" style="display:none" @change="pickFile">
        </div>
        <EmojiPop v-if="emojiOpen" @pick="addEmoji" />
      </div>
    </div>
    <div class="col col-chat" v-else><div class="empty" style="margin:auto">选择左侧会话开始接待</div></div>
    <div class="col col-info" v-if="conv && visitor"><VisitorPanel :v="visitorView" :conv="conv" @changed="reloadVisitor" /></div>
  </div>`,
  data: () => ({
    S, q: '', site: '0', filter: 'open', list0: null, conv: null, visitor: null, text: '', mode: 'reply', sending: false,
    emojiOpen: false, aiText: '', aiTitle: '', aiKind: '', aiBusy: false, rewriteOpen: false, cannedOpen: false, cannedIdx: 0, typingSent: 0,
    tabs: [['open', '进行中'], ['mine', '我的'], ['unassigned', '未分配'], ['closed', '已结束']],
    rewrites: [['polish', '润色'], ['shorter', '更简洁'], ['friendly', '更亲切'], ['en', '翻译为英文'], ['zh', '翻译为中文'], ['ja', '翻译为日文'], ['ru', '翻译为俄文'], ['fa', '翻译为波斯语']],
  }),
  computed: {
    list() {
      // the "open" tab is kept live from websocket events; other tabs are fetched snapshots
      if (this.filter === 'open' && this.site === '0' && !this.q) return S.convs.filter(c => c.status === 'open');
      return this.list0 || [];
    },
    unreadTotal() { return S.convs.reduce((a, c) => a + (c.unread || 0), 0); },
    live() { return this.conv ? S.live[this.conv.visitor_id] : null; },
    visitorView() { return Object.assign({}, this.visitor, { live: this.live || null }); },
    cannedList() {
      if (!this.text.startsWith('/')) return [];
      const k = this.text.slice(1).toLowerCase();
      return S.canned.filter(c => c.shortcut.toLowerCase().includes(k) || c.body.toLowerCase().includes(k)).slice(0, 8);
    },
  },
  watch: {
    'S.route.id': { immediate: true, handler(id) { this.open(id); } },
    'S.convs': { deep: true, handler() { if (this.conv) { const c = S.convs.find(x => x.id === this.conv.id); if (c) this.conv = Object.assign({}, this.conv, c); } } },
    'S.chatMsgs.length'() { this.scroll(); },
  },
  methods: {
    go, fmtTime, rich, vn: visitorName,
    aiSite(id) { const s = S.sites.find(x => x.id === id); return S.ai && s && s.ai_mode !== 'off'; },
    cls(m) { return { out: m.sender_type === 'agent', ai: m.sender_type === 'ai', note: m.sender_type === 'note', sys: m.sender_type === 'system' }; },
    who(m) { return { visitor: '访客', agent: m.sender_name, ai: 'AI · ' + (m.sender_name || 'AI'), note: m.sender_name || '系统' }[m.sender_type] || ''; },
    async load() {
      if (this.filter === 'open' && this.site === '0' && !this.q) { await loadConvs(); this.list0 = null; return; }
      try { this.list0 = await api('GET', '/api/conversations?filter=' + this.filter + '&site_id=' + this.site + '&q=' + encodeURIComponent(this.q)); } catch (e) { toast(e.message, true); }
    },
    async open(id) {
      id = parseInt(id) || 0;
      S.openConvId = id; this.aiText = '';
      if (!id) { this.conv = null; S.chatMsgs = []; return; }
      try {
        const r = await api('GET', '/api/conversations/' + id);
        if (S.openConvId !== id) return;
        this.conv = r.conversation; S.chatMsgs = r.messages; this.visitor = r.visitor;
        this.text = localStorage.getItem('kc_draft_' + id) || '';
        if (r.conversation.unread) api('POST', '/api/conversations/' + id + '/read').catch(() => {});
        this.scroll(); nextTick(() => this.$refs.ta && this.$refs.ta.focus());
      } catch (e) { toast(e.message, true); }
    },
    async reloadVisitor() { if (this.conv) this.visitor = await api('GET', '/api/visitors/' + this.conv.visitor_id); },
    scroll() { nextTick(() => { const el = this.$refs.msgs; if (el) el.scrollTop = el.scrollHeight; }); },
    onInput() {
      this.cannedOpen = this.text.startsWith('/'); this.cannedIdx = 0;
      if (this.conv) localStorage.setItem('kc_draft_' + this.conv.id, this.text);
      if (this.mode === 'reply' && Date.now() - this.typingSent > 2500) { this.typingSent = Date.now(); wsSend('typing', { conversation_id: this.conv.id, typing: true }); }
    },
    keydown(e) {
      if (this.cannedOpen && this.cannedList.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.cannedIdx = (this.cannedIdx + 1) % this.cannedList.length; return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this.cannedIdx = (this.cannedIdx + this.cannedList.length - 1) % this.cannedList.length; return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.useCanned(this.cannedList[this.cannedIdx]); return; }
        if (e.key === 'Escape') { this.cannedOpen = false; return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    },
    addEmoji(e) { this.text = insertAt(this.$refs.ta, this.text, e); },
    useCanned(c) {
      const v = this.visitorView;
      this.text = c.body.replace(/\{name\}/g, v.name || '').replace(/\{email\}/g, v.email || '');
      this.cannedOpen = false; this.$refs.ta.focus();
    },
    async send(att) {
      const body = this.text.trim();
      if ((!body && !att) || this.sending) return;
      this.sending = true;
      try {
        const m = await api('POST', '/api/conversations/' + this.conv.id + '/messages', { body, attachment: att || null, note: this.mode === 'note' });
        if (!S.chatMsgs.some(x => x.id === m.id)) S.chatMsgs.push(m);
        this.text = ''; localStorage.removeItem('kc_draft_' + this.conv.id);
        wsSend('typing', { conversation_id: this.conv.id, typing: false });
      } catch (e) { toast(e.message, true); }
      this.sending = false;
    },
    async pickFile(e) {
      const f = e.target.files[0]; e.target.value = '';
      if (f) this.sendFile(f);
    },
    async sendFile(f) {
      try { const a = await uploadFile(f); const t = this.text; this.text = ''; await this.send(a); this.text = t; } catch (err) { toast(err.message, true); }
    },
    paste(e) {
      const f = [...(e.clipboardData || {}).files || []][0];
      if (f) { e.preventDefault(); this.sendFile(f); }
    },
    async toggleAI() {
      try { const c = await api('POST', '/api/conversations/' + this.conv.id + '/update', { ai_paused: !this.conv.ai_paused }); upsertConv(c); } catch (e) { toast(e.message, true); }
    },
    async assign(uid) {
      try { const c = await api('POST', '/api/conversations/' + this.conv.id + '/update', { assignee_id: parseInt(uid) }); upsertConv(c); toast('已转接'); } catch (e) { toast(e.message, true); }
    },
    async setStatus(s) {
      try {
        const c = await api('POST', '/api/conversations/' + this.conv.id + '/update', { status: s }); upsertConv(c); this.conv = Object.assign({}, this.conv, c);
        if (s === 'closed') { S.convs = S.convs.filter(x => x.id !== c.id || x.status === 'open'); }
        this.open(this.conv.id);
      } catch (e) { toast(e.message, true); }
    },
    async suggest() {
      this.aiBusy = true;
      try {
        const r = await api('POST', '/api/ai/suggest', { conversation_id: this.conv.id, hint: this.text.startsWith('/') ? '' : this.text });
        this.aiText = r.text; this.aiTitle = 'AI 建议回复'; this.aiKind = 'suggest';
      } catch (e) { toast(e.message, true); }
      this.aiBusy = false;
    },
    useAI() { this.text = this.aiText.replace(/\[待确认:[^\]]*\]/g, m => m); this.aiText = ''; this.$refs.ta.focus(); },
    async rewrite(mode) {
      this.rewriteOpen = false;
      if (!this.text.trim()) return toast('请先在输入框写内容', true);
      this.aiBusy = true;
      try { const r = await api('POST', '/api/ai/rewrite', { text: this.text, mode }); this.text = r.text; } catch (e) { toast(e.message, true); }
      this.aiBusy = false;
    },
    async summarize() {
      this.aiBusy = true;
      try { const r = await api('POST', '/api/ai/summarize', { conversation_id: this.conv.id }); this.aiText = r.text; this.aiTitle = '会话总结'; this.aiKind = 'summary'; } catch (e) { toast(e.message, true); }
      this.aiBusy = false;
    },
  },
  unmounted() { S.openConvId = 0; },
};

const Team = {
  components: { Avatar, Modal, Attachment, EmojiPop },
  template: `<div class="content flush" :class="{'has-chat':!!ch}" style="flex:1">
    <div class="col col-list tlist" style="width:260px;overflow-y:auto">
      <div class="sec">频道 <button class="btn sm ghost" @click="openCreate('public')" title="新建频道"><Icon n="plus" :s="16"/></button></div>
      <a v-for="c in byKind('public')" :key="c.id" :class="{on:ch&&ch.id===c.id}" @click="go('team/'+c.id)"># {{c.name}}<span class="ub" v-if="c.unread">{{c.unread}}</span></a>
      <a v-for="c in S.joinable" :key="'j'+c.id" class="muted" @click="join(c)"># {{c.name}} <span class="small" style="margin-left:auto">加入</span></a>
      <div class="sec">私人群组 <button class="btn sm ghost" @click="openCreate('private')" title="新建私人群组"><Icon n="plus" :s="16"/></button></div>
      <a v-for="c in byKind('private')" :key="c.id" :class="{on:ch&&ch.id===c.id}" @click="go('team/'+c.id)"><Icon n="lock" :s="16"/>{{c.name}}<span class="ub" v-if="c.unread">{{c.unread}}</span></a>
      <div v-if="!byKind('private').length" class="small muted" style="padding:4px 14px">还没有群组，点右上角 + 创建</div>
      <div class="sec">私信</div>
      <a v-for="u in others" :key="'u'+u.id" :class="{on:ch&&ch.kind==='dm'&&ch.peer_id===u.id}" @click="dm(u)">
        <Avatar :name="u.name" :online="u.online" small /> {{u.name}}<span class="ub" v-if="dmUnread(u.id)">{{dmUnread(u.id)}}</span></a>
    </div>
    <div class="col col-chat" v-if="ch">
      <div class="chat-h">
        <button class="btn sm ghost mob-only" @click="go('team')"><Icon n="back"/></button>
        <div class="t"><div style="font-weight:600">{{ch.name}}</div><div class="small muted ell">{{ch.kind==='dm' ? '私信' : (ch.topic || (ch.members.length + ' 位成员'))}}</div></div>
        <button class="btn sm" v-if="ch.kind!=='dm'" @click="showMembers=true"><Icon n="people" :s="16"/>成员 {{ch.members.length}}</button>
      </div>
      <div class="msgs" ref="msgs" @scroll="onScroll" style="gap:2px">
        <template v-for="(m,i) in S.teamMsgs" :key="m.id">
          <div v-if="m.user_id===0 && m.user_name==='系统'" class="tm-sys">{{m.body}} · {{fmtTime(m.created_at)}}</div>
          <div v-else class="tm-row" :class="{cont:cont(i)}" style="margin-top:6px">
            <Avatar v-if="!cont(i)" :name="m.user_name" :seed="m.user_id||'ai'" small />
            <div class="bd"><div class="nm" v-if="!cont(i)">{{m.user_name}}<span class="tag purple" v-if="m.user_id===0" style="margin-left:0">AI</span><span>{{fmtTime(m.created_at)}}</span></div>
              <div class="tx"><span v-html="rich(m.body)"></span><Attachment :a="m.attachment"/></div></div>
          </div>
        </template>
        <div v-if="!S.teamMsgs.length" class="empty">还没有消息，打个招呼吧 👋</div>
      </div>
      <div class="small muted" style="padding:0 20px 4px;min-height:20px">{{S.teamTyping[ch.id] ? S.teamTyping[ch.id] + ' 正在输入…' : ''}}</div>
      <div class="composer">
        <EmojiPop v-if="emojiOpen" @pick="addEmoji" />
        <textarea ref="ta" v-model="text" :placeholder="'发送到 ' + ch.name + '，Enter 发送；@AI 召唤 AI 助手'" @keydown="keydown" @input="typing" @paste="paste"></textarea>
        <div class="tools"><button class="btn sm ghost" title="表情" @click="emojiOpen=!emojiOpen"><Icon n="smile"/></button><button class="btn sm ghost" title="发图片" @click="$refs.img.click()"><Icon n="photo"/></button><button class="btn sm ghost" @click="$refs.file.click()">📎</button><input type="file" ref="img" accept="image/*" style="display:none" @change="pickFile">
          <button class="btn sm ghost" @click="text+=(text?' ':'')+'@AI '" v-if="S.ai"><Icon n="sparkles" :s="18"/>@AI</button>
          <span style="flex:1"></span><button class="btn pri sm" @click="send()">发送</button>
          <input type="file" ref="file" style="display:none" @change="pickFile"></div>
      </div>
    </div>
    <div class="col col-chat" v-else><div class="empty" style="margin:auto">选择左侧频道、群组或同事开始聊天</div></div>

    <Modal v-if="create" :title="create.kind==='public'?'新建公开频道':'新建私人群组'" @close="create=null">
      <div class="field"><label>名称</label><input class="inp" v-model="create.name" maxlength="40"></div>
      <div class="field"><label>简介</label><input class="inp" v-model="create.topic"></div>
      <div class="field" v-if="create.kind==='private'"><label>成员</label>
        <label v-for="u in others" :key="u.id" class="row" style="font-weight:400;margin-bottom:6px"><input type="checkbox" :value="u.id" v-model="create.members"> {{u.name}} <span class="muted small">{{u.email}}</span></label>
        <div class="hint">私人群组只有成员可见，可随时邀请其他人。</div></div>
      <div class="hint" v-else>公开频道全员自动加入。</div>
      <template #foot><button class="btn" @click="create=null">取消</button><button class="btn pri" @click="doCreate">创建</button></template>
    </Modal>
    <Modal v-if="showMembers && ch" title="群组成员" @close="showMembers=false">
      <div v-if="canManage" class="field"><label>群组名称</label><div class="row"><input class="inp" v-model="rename"><button class="btn" @click="saveName">保存</button></div></div>
      <div v-for="m in ch.members" :key="m.id" class="row" style="margin-bottom:8px">
        <Avatar :name="m.name" :online="m.online" small /><div style="flex:1">{{m.name}} <span class="tag" v-if="m.role==='owner'">群主</span></div>
        <button class="btn sm" v-if="m.id!==S.user.id" @click="dmUser(m.id)">私信</button>
        <button class="btn sm dan" v-if="canManage && m.id!==S.user.id && ch.kind==='private'" @click="kick(m)">移除</button></div>
      <div v-if="ch.kind==='private' && invitable.length" class="field" style="margin-top:16px"><label>邀请成员</label>
        <div class="row"><select class="inp" v-model="inviteId"><option value="">选择同事</option><option v-for="u in invitable" :value="u.id">{{u.name}}</option></select><button class="btn pri" @click="invite">邀请</button></div></div>
      <template #foot>
        <button class="btn dan" v-if="canManage" @click="dissolve">解散群组</button>
        <button class="btn" v-if="ch.kind==='private'" @click="leave">退出群组</button>
        <button class="btn pri" @click="showMembers=false">完成</button></template>
    </Modal>
  </div>`,
  data: () => ({ S, emojiOpen: false, ch: null, text: '', create: null, showMembers: false, inviteId: '', rename: '', typingAt: 0, loadingMore: false }),
  computed: {
    others() { return S.users.filter(u => u.id !== S.user.id); },
    canManage() { return this.ch && this.ch.kind !== 'dm' && (this.ch.my_role === 'owner' || S.user.role === 'admin'); },
    invitable() { return this.ch ? S.users.filter(u => !this.ch.members.some(m => m.id === u.id)) : []; },
  },
  watch: {
    'S.route.id': { immediate: true, handler(id) { this.open(id); } },
    'S.teamMsgs.length'(n, o) { if (!this.loadingMore) this.scroll(); },
    'S.channels': { deep: true, handler() { if (this.ch) { const c = S.channels.find(x => x.id === this.ch.id); if (c) { this.ch.members = c.members; this.ch.name = c.name; this.ch.topic = c.topic; } } } },
  },
  methods: {
    go, fmtTime, rich,
    byKind(k) { return S.channels.filter(c => c.kind === k).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)); },
    dmUnread(uid) { const c = S.channels.find(c => c.kind === 'dm' && c.peer_id === uid); return c ? c.unread : 0; },
    cont(i) {
      const a = S.teamMsgs[i - 1], b = S.teamMsgs[i];
      return a && a.user_id === b.user_id && a.user_name === b.user_name && a.user_name !== '系统' && b.created_at - a.created_at < 5 * 60000;
    },
    async open(id) {
      id = parseInt(id) || 0;
      S.openChannelId = id;
      if (!id) { this.ch = null; S.teamMsgs = []; return; }
      try {
        const [c, msgs] = await Promise.all([api('GET', '/api/channels/' + id), api('GET', '/api/channels/' + id + '/messages')]);
        if (S.openChannelId !== id) return;
        this.ch = c; this.rename = c.name; S.teamMsgs = msgs;
        const lc = S.channels.find(x => x.id === id); if (lc) lc.unread = 0;
        api('POST', '/api/channels/' + id + '/read').catch(() => {});
        this.scroll();
      } catch (e) { toast(e.message, true); go('team'); }
    },
    scroll() { nextTick(() => { const el = this.$refs.msgs; if (el) el.scrollTop = el.scrollHeight; }); },
    async onScroll(e) {
      const el = e.target;
      if (el.scrollTop > 40 || this.loadingMore || !S.teamMsgs.length) return;
      this.loadingMore = true;
      const h = el.scrollHeight;
      try {
        const older = await api('GET', '/api/channels/' + this.ch.id + '/messages?before=' + S.teamMsgs[0].id);
        if (older.length) { S.teamMsgs.unshift(...older); await nextTick(); el.scrollTop = el.scrollHeight - h; }
      } catch (x) {}
      setTimeout(() => { this.loadingMore = false; }, 300);
    },
    keydown(e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } },
    addEmoji(e) { this.text = insertAt(this.$refs.ta, this.text, e); },
    typing() { if (Date.now() - this.typingAt > 2500) { this.typingAt = Date.now(); wsSend('team_typing', { channel_id: this.ch.id }); } },
    async send(att) {
      const body = this.text.trim();
      if (!body && !att) return;
      try {
        const m = await api('POST', '/api/channels/' + this.ch.id + '/messages', { body, attachment: att || null });
        if (!S.teamMsgs.some(x => x.id === m.id)) S.teamMsgs.push(m);
        this.text = '';
      } catch (e) { toast(e.message, true); }
    },
    async pickFile(e) { const f = e.target.files[0]; e.target.value = ''; if (f) this.sendFile(f); },
    async sendFile(f) { try { const a = await uploadFile(f); const t = this.text; this.text = ''; await this.send(a); this.text = t; } catch (err) { toast(err.message, true); } },
    paste(e) { const f = [...(e.clipboardData || {}).files || []][0]; if (f) { e.preventDefault(); this.sendFile(f); } },
    openCreate(kind) { this.create = { kind, name: '', topic: '', members: [] }; },
    async doCreate() {
      try { const c = await api('POST', '/api/channels', this.create); this.create = null; await loadChannels(); go('team/' + c.id); } catch (e) { toast(e.message, true); }
    },
    async dm(u) { this.dmUser(u.id); },
    async dmUser(uid) {
      try { const c = await api('POST', '/api/channels/dm', { user_id: uid }); this.showMembers = false; await loadChannels(); go('team/' + c.id); } catch (e) { toast(e.message, true); }
    },
    async join(c) { try { await api('POST', '/api/channels/' + c.id + '/members', {}); await loadChannels(); go('team/' + c.id); } catch (e) { toast(e.message, true); } },
    async invite() {
      if (!this.inviteId) return;
      try { this.ch = await api('POST', '/api/channels/' + this.ch.id + '/members', { user_ids: [parseInt(this.inviteId)] }); this.inviteId = ''; } catch (e) { toast(e.message, true); }
    },
    async kick(m) {
      if (!confirm('移除 ' + m.name + '？')) return;
      try { await api('DELETE', '/api/channels/' + this.ch.id + '/members/' + m.id); this.ch = await api('GET', '/api/channels/' + this.ch.id); } catch (e) { toast(e.message, true); }
    },
    async leave() {
      if (!confirm('确定退出该群组？')) return;
      try { await api('DELETE', '/api/channels/' + this.ch.id + '/members/' + S.user.id); this.showMembers = false; await loadChannels(); go('team'); } catch (e) { toast(e.message, true); }
    },
    async dissolve() {
      if (!confirm('解散后所有消息将被删除，确定？')) return;
      try { await api('DELETE', '/api/channels/' + this.ch.id); this.showMembers = false; await loadChannels(); go('team'); } catch (e) { toast(e.message, true); }
    },
    async saveName() { try { await api('PUT', '/api/channels/' + this.ch.id, { name: this.rename }); toast('已保存'); } catch (e) { toast(e.message, true); } },
  },
  unmounted() { S.openChannelId = 0; },
};


const Community = {
  components: { Avatar, Modal, Attachment, EmojiPop },
  template: `<div class="content flush" :class="{'has-chat':!!room}" style="flex:1">
    <div class="col col-list tlist" style="width:280px;overflow-y:auto">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border)" class="small">
        <div class="row"><span class="dot" :class="{on:S.community.enabled}"></span><b style="flex:1">{{S.community.enabled?'社区已开放':'社区未开放'}}</b>
          <button class="btn sm" v-if="isAdmin" @click="openCfg">设置</button></div>
        <a v-if="S.community.url" :href="S.community.url" target="_blank" rel="noopener" class="ell" style="display:block;margin-top:4px">{{S.community.url}}</a>
      </div>
      <div class="sec">群组 <button class="btn sm ghost" v-if="isAdmin" @click="edit({})" title="新建群组"><Icon n="plus" :s="16"/></button></div>
      <a v-for="r in S.rooms" :key="r.id" :class="{on:room&&room.id===r.id}" @click="go('community/'+r.id)">
        <Icon :n="r.kind==='public'?'hash':'lock'" :s="16"/><span class="ell" style="flex:1">{{r.name}}</span>
        <span class="tag" v-if="r.tg_chat_id" style="background:#229ed9;color:#fff">TG</span><span class="small muted">{{r.member_count}}</span></a>
      <div v-if="!S.rooms.length" class="small muted" style="padding:8px 14px">还没有群组，点右上角 + 创建</div>
    </div>
    <div class="col col-chat" v-if="room">
      <div class="chat-h">
        <button class="btn sm ghost mob-only" @click="go('community')"><Icon n="back"/></button>
        <div class="t"><div style="font-weight:600">{{room.name}}
          <span class="tag" v-if="room.readonly">公告频道</span><span class="tag" v-if="room.slow_mode">慢速 {{room.slow_mode}}s</span></div>
          <div class="small muted ell">{{room.member_count}} 位成员 · {{room.description}}</div></div>
        <button class="btn sm" @click="invite">邀请链接</button>
        <button class="btn sm" v-if="isAdmin" @click="edit(room)">群设置</button>
      </div>
      <div class="pin-bar small" v-if="room.pinned && !room.pinned.deleted" style="padding:6px 16px;background:var(--panel);border-bottom:1px solid var(--border)"><b style="color:var(--primary)">置顶</b> {{room.pinned.body}} <a style="cursor:pointer;margin-left:8px" @click="pin(0)">取消置顶</a></div>
      <div class="msgs" ref="msgs" @scroll="onScroll" style="gap:2px">
        <template v-for="m in S.roomMsgs" :key="m.id">
          <div v-if="m.sender_kind==='system'" class="tm-sys">{{m.body}} · {{fmtTime(m.created_at)}}</div>
          <div v-else class="tm-row" style="margin-top:6px">
            <Avatar :name="m.sender_name" :seed="m.sender_kind+m.sender_id" small />
            <div class="bd"><div class="nm">{{m.sender_name}}
              <span class="tag amber" v-if="m.sender_kind==='staff'">官方</span><span class="tag" v-if="m.sender_kind==='tg'" style="background:#229ed9;color:#fff">TG</span>
              <span>{{fmtTime(m.created_at)}}</span>
              <span class="acts" v-if="!m.deleted"><a @click="reply=m">回复</a><a @click="pin(m.id)">置顶</a><a class="danger" @click="del(m)">删除</a><a class="danger" v-if="m.sender_kind==='member'" @click="moderate(m.sender_id, m.sender_name)">处理</a></span></div>
              <div class="small muted" v-if="m.reply" style="border-left:3px solid var(--primary);padding-left:6px;margin:2px 0">{{m.reply.sender_name}}：{{m.reply.body}}</div>
              <div class="tx" v-if="m.deleted"><i class="muted">消息已删除</i></div>
              <div class="tx" v-else><span v-html="rich(m.body)"></span><Attachment :a="m.attachment"/></div></div>
          </div>
        </template>
        <div v-if="!S.roomMsgs.length" class="empty">还没有消息</div>
      </div>
      <div class="composer">
        <div class="small muted" v-if="reply" style="padding-bottom:6px">回复 <b>{{reply.sender_name}}</b>：{{(reply.body||'').slice(0,60)}} <a style="cursor:pointer" @click="reply=null">✕</a></div>
        <EmojiPop v-if="emojiOpen" @pick="addEmoji" />
        <textarea ref="ta" v-model="text" placeholder="以官方身份发言，Enter 发送" @keydown="keydown" @paste="paste"></textarea>
        <div class="tools"><button class="btn sm ghost" title="表情" @click="emojiOpen=!emojiOpen"><Icon n="smile"/></button><button class="btn sm ghost" title="发图片" @click="$refs.img.click()"><Icon n="photo"/></button><button class="btn sm ghost" @click="$refs.file.click()">📎</button><span style="flex:1"></span>
          <button class="btn pri sm" @click="send()">发送</button><input type="file" ref="file" style="display:none" @change="pick"><input type="file" ref="img" accept="image/*" style="display:none" @change="pick"></div>
      </div>
    </div>
    <div class="col col-chat" v-else><div class="empty" style="margin:auto">选择左侧群组</div></div>
    <div class="col col-info" v-if="room">
      <div class="info-s"><h4>成员（{{members.length}}）</h4>
        <div v-for="m in members" :key="m.id" class="row" style="margin-bottom:8px;align-items:flex-start">
          <Avatar :name="m.name" :seed="'member'+m.id" :online="m.online" small />
          <div style="flex:1;min-width:0"><div class="ell">{{m.name}} <span class="tag red" v-if="m.banned">封禁</span><span class="tag amber" v-if="m.muted_until>Date.now()">禁言中</span></div>
            <div class="small muted ell">{{m.email}}</div><div class="small muted ell" v-if="ext(m).plan">{{ext(m).plan}} · {{ext(m).expired_at}}</div></div>
          <button class="btn sm ghost" @click="moderate(m.id, m.name)"><Icon n="more" :s="18"/></button></div>
      </div>
    </div>

    <Modal v-if="cur" :title="cur.id?'群组设置':'新建群组'" @close="cur=null">
      <div class="field"><label>名称</label><input class="inp" v-model="cur.name" maxlength="40"></div>
      <div class="field"><label>简介</label><input class="inp" v-model="cur.description"></div>
      <div class="grid g2" style="gap:0 16px">
        <div class="field"><label>类型</label><select class="inp" v-model="cur.kind"><option value="public">公开（所有人可见可加入）</option><option value="private">私密（凭邀请链接加入）</option></select></div>
        <div class="field"><label>颜色</label><div class="row"><input type="color" v-model="cur.color" style="width:44px;height:34px;border:0;background:none"><input class="inp" v-model="cur.color"></div></div>
        <div class="field"><label>慢速模式（秒，0 关闭）</label><input class="inp" type="number" min="0" v-model.number="cur.slow_mode"></div>
        <div class="field"><label>排序（越大越靠前）</label><input class="inp" type="number" v-model.number="cur.sort"></div>
      </div>
      <div class="field"><label class="row">允许成员邀请好友 <span class="switch" :class="{on:cur.member_invite}" @click="cur.member_invite=cur.member_invite?0:1"></span></label></div>
      <div class="field"><label class="row">公告频道（仅官方可发言） <span class="switch" :class="{on:cur.readonly}" @click="cur.readonly=cur.readonly?0:1"></span></label></div>
      <div class="field"><label>互通 Telegram 群组</label>
        <select class="inp" v-model="cur.tg_chat_id"><option value="">不互通</option>
          <option v-for="c in tgChats" :value="c.id">{{c.title}}（{{c.id}}）</option></select>
        <div class="hint" v-if="!(S.community.tg||{}).running">先在 系统设置 → Telegram 配置机器人，并把机器人拉进群</div></div>
      <template #foot><button class="btn dan" v-if="cur.id" style="margin-right:auto" @click="remove">删除群组</button><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="save">保存</button></template>
    </Modal>
    <Modal v-if="mod" :title="'处理成员：'+mod.name" @close="mod=null">
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn" v-for="t in [[10,'禁言 10 分钟'],[60,'禁言 1 小时'],[1440,'禁言 1 天'],[10080,'禁言 7 天']]" :key="t[0]" @click="act('mute',t[0])">{{t[1]}}</button>
        <button class="btn" @click="act('mute',0)">解除禁言</button>
        <button class="btn dan" @click="act('kick')">移出群组</button>
        <button class="btn dan" @click="act('ban')">移出并禁止再加入</button>
        <button class="btn dan" @click="globalBan(true)">封禁账号（全部群组）</button>
        <button class="btn" @click="globalBan(false)">解除账号封禁</button>
      </div>
    </Modal>
    <Modal v-if="cfg" title="社区设置" @close="cfg=null">
      <div class="field"><label class="row">开放社区 <span class="switch" :class="{on:cfg.community_enabled==='1'}" @click="cfg.community_enabled=cfg.community_enabled==='1'?'0':'1'"></span></label>
        <div class="hint">开启后，访客挂件会出现「群聊」按钮，已登录 Xboard 的用户点一下就能进入</div></div>
      <div class="field"><label>账户系统地址（Xboard）</label><input class="inp" v-model="cfg.community_xboard_url" placeholder="https://your-xboard.example.com">
        <div class="hint">直接打开社区页面时，用这个 Xboard 校验邮箱和密码</div></div>
      <div class="field"><label>社区名称</label><input class="inp" v-model="cfg.brand_name" placeholder="Koyun 社区"></div>
      <div class="field"><label>社区地址（可选）</label><input class="inp" v-model="cfg.community_url" placeholder="留空 = 默认地址">
        <div class="hint">绑定其他域名（例如未被污染的域名）后可以填在这里</div></div>
      <template #foot><button class="btn" @click="cfg=null">取消</button><button class="btn pri" @click="saveCfg">保存</button></template>
    </Modal>
    <Modal v-if="inviteURL" title="邀请链接" @close="inviteURL=''"><div class="code">{{inviteURL}}</div><div class="hint">7 天内有效，最多 50 人使用</div>
      <template #foot><button class="btn pri" @click="copy(inviteURL)">复制</button></template></Modal>
  </div>`,
  data: () => ({ S, emojiOpen: false, room: null, text: '', reply: null, members: [], cur: null, mod: null, cfg: null, inviteURL: '', loadingOld: false }),
  computed: {
    isAdmin() { return S.user.role === 'admin'; },
    tgChats() { return ((S.community.tg || {}).chats || []).filter(c => c.id !== (S.community.tg || {}).support_chat_id); },
  },
  watch: {
    'S.route.id': { immediate: true, handler(id) { this.open(id); } },
    'S.rooms': { deep: true, handler() { if (this.room) { const r = S.rooms.find(x => x.id === this.room.id); if (r) this.room = r; } } },
    'S.roomMsgs.length'() { if (!this.loadingOld) this.scroll(); },
  },
  methods: {
    go, fmtTime, rich, ext: m => parseExt(m.ext),
    async open(id) {
      id = parseInt(id) || 0;
      if (!S.rooms.length) await loadRooms();
      S.openRoomId = id; this.reply = null;
      this.room = S.rooms.find(r => r.id === id) || null;
      if (!this.room) { S.roomMsgs = []; return; }
      S.roomMsgs = await api('GET', '/api/community/rooms/' + id + '/messages');
      this.loadMembers(); this.scroll();
    },
    async loadMembers() { if (this.room) this.members = await api('GET', '/api/community/rooms/' + this.room.id + '/members'); },
    scroll() { nextTick(() => { const el = this.$refs.msgs; if (el) el.scrollTop = el.scrollHeight; }); },
    async onScroll(e) {
      const el = e.target;
      if (el.scrollTop > 40 || this.loadingOld || S.roomMsgs.length < 60) return;
      this.loadingOld = true; const h = el.scrollHeight;
      try { const old = await api('GET', '/api/community/rooms/' + this.room.id + '/messages?before=' + S.roomMsgs[0].id);
        if (old.length) { S.roomMsgs.unshift(...old); await nextTick(); el.scrollTop = el.scrollHeight - h; } } catch (x) {}
      setTimeout(() => { this.loadingOld = false; }, 300);
    },
    keydown(e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } },
    addEmoji(e) { this.text = insertAt(this.$refs.ta, this.text, e); },
    async send(att) {
      const body = this.text.trim(); if (!body && !att) return;
      try { const m = await api('POST', '/api/community/rooms/' + this.room.id + '/messages', { body, attachment: att || null, reply_to: this.reply ? this.reply.id : 0 });
        if (!S.roomMsgs.some(x => x.id === m.id)) S.roomMsgs.push(m); if (!att) this.text = ''; this.reply = null; } catch (e) { toast(e.message, true); }
    },
    async upFile(f) { try { const a = await uploadFile(f); const t = this.text; this.text = ''; await this.send(a); this.text = t; } catch (e) { toast(e.message, true); } },
    pick(e) { const f = e.target.files[0]; e.target.value = ''; if (f) this.upFile(f); },
    paste(e) { const f = [...((e.clipboardData || {}).files || [])][0]; if (f) { e.preventDefault(); this.upFile(f); } },
    async del(m) { if (!confirm('删除这条消息？')) return; try { await api('DELETE', '/api/community/messages/' + m.id); } catch (e) { toast(e.message, true); } },
    async pin(id) { try { await api('POST', '/api/community/rooms/' + this.room.id + '/pin', { message_id: id }); await loadRooms(); } catch (e) { toast(e.message, true); } },
    moderate(id, name) { this.mod = { id, name }; },
    async act(action, minutes) {
      try { await api('POST', '/api/community/rooms/' + this.room.id + '/moderate', { member_id: this.mod.id, action, minutes: minutes || 0 }); toast('已处理'); this.mod = null; this.loadMembers(); loadRooms(); } catch (e) { toast(e.message, true); }
    },
    async globalBan(b) {
      if (b && !confirm('封禁后该用户无法在任何群组发言，确定？')) return;
      try { await api('POST', '/api/community/members/' + this.mod.id + '/ban', { banned: b }); toast('已处理'); this.mod = null; this.loadMembers(); } catch (e) { toast(e.message, true); }
    },
    async invite() { try { this.inviteURL = (await api('POST', '/api/community/rooms/' + this.room.id + '/invite')).url; } catch (e) { toast(e.message, true); } },
    copy(t) { navigator.clipboard.writeText(t).then(() => toast('已复制')); },
    edit(r) { this.cur = Object.assign({ name: '', description: '', kind: 'public', color: '#0071e3', slow_mode: 0, sort: 0, member_invite: 1, readonly: 0, tg_chat_id: '' }, r); },
    async save() {
      const c = this.cur, body = { name: c.name, description: c.description, kind: c.kind, color: c.color, slow_mode: c.slow_mode || 0, sort: c.sort || 0, member_invite: c.member_invite ? 1 : 0, readonly: c.readonly ? 1 : 0, tg_chat_id: c.tg_chat_id || '' };
      try { if (c.id) await api('PUT', '/api/community/rooms/' + c.id, body); else { const r = await api('POST', '/api/community/rooms', body); go('community/' + r.id); }
        this.cur = null; await loadRooms(); toast('已保存'); } catch (e) { toast(e.message, true); }
    },
    async remove() {
      if (prompt('删除群组会清空所有消息。输入群组名称确认：') !== this.cur.name) return;
      try { await api('DELETE', '/api/community/rooms/' + this.cur.id); this.cur = null; await loadRooms(); go('community'); } catch (e) { toast(e.message, true); }
    },
    openCfg() { this.cfg = { community_enabled: S.community.enabled ? '1' : '0', community_xboard_url: S.community.xboard_url || '', community_url: '', brand_name: '' }; },
    async saveCfg() { try { await api('PUT', '/api/community/settings', this.cfg); this.cfg = null; await loadRooms(); toast('已保存'); } catch (e) { toast(e.message, true); } },
  },
  unmounted() { S.openRoomId = 0; },
};

const History = {
  components: { Avatar, Modal, VisitorPanel },
  template: `<div class="card"><div class="card-h">访客记录 <span style="flex:1"></span><input class="inp" style="width:260px" v-model="q" placeholder="搜索称呼 / 邮箱 / IP" @keyup.enter="load"><button class="btn" @click="load">搜索</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>访客</th><th>站点账户</th><th>位置 / IP</th><th>设备</th><th>访问</th><th>最后访问</th><th></th></tr></thead><tbody>
      <tr v-for="v in list" :key="v.id"><td><div class="row"><Avatar :name="vn(v)" :seed="v.id" :online="!!S.live[v.id]" small /><div>{{vn(v)}}<div class="small muted">{{v.email}}</div></div></div></td>
        <td class="small">{{ext(v).plan||'-'}}<div class="muted" v-if="ext(v).expired_at">到期 {{ext(v).expired_at}}</div></td>
        <td>{{geo(v)}}<div class="small muted">{{v.ip}}</div></td><td class="small">{{v.device}} · {{v.os}} · {{v.browser}}</td>
        <td>{{v.visits}} 次</td><td class="small">{{fmtTime(v.last_seen)}}</td>
        <td><button class="btn sm" @click="detail(v)">详情</button> <span v-if="v.blocked" class="tag red">已屏蔽</span></td></tr>
      <tr v-if="!list.length"><td colspan="7" class="empty">暂无数据</td></tr></tbody></table></div>
    <Modal v-if="cur" title="访客详情" @close="cur=null"><VisitorPanel :v="cur" @changed="reload" /></Modal>
  </div>`,
  data: () => ({ S, q: '', list: [], cur: null }),
  methods: {
    fmtTime, vn: visitorName, ext: v => parseExt(v.ext), geo: geoText,
    async load() { try { this.list = await api('GET', '/api/visitors?q=' + encodeURIComponent(this.q)); } catch (e) { toast(e.message, true); } },
    async detail(v) { try { const d = await api('GET', '/api/visitors/' + v.id); d.live = S.live[v.id] || null; this.cur = d; } catch (e) { toast(e.message, true); } },
    async reload() { if (this.cur) await this.detail(this.cur); this.load(); },
  },
  mounted() { this.load(); },
};

const Sites = {
  components: { Modal },
  template: `<div>
    <div class="row" style="margin-bottom:16px"><div class="muted small" style="flex:1">每个网站创建一个站点，所有站点的访客统一在工作台接待。</div><button class="btn pri" v-if="isAdmin" @click="edit({})"><Icon n="plus" :s="16"/>新建站点</button></div>
    <div class="grid g2">
      <div class="card" v-for="s in list" :key="s.id"><div class="card-h"><span class="dot on" :style="{background:s.color}"></span>{{s.name}}
        <span class="tag purple" v-if="s.ai_mode!=='off'">AI {{s.ai_mode==='always'?'优先接待':'离线接待'}}</span><span class="tag amber" v-if="s.xboard">Xboard</span>
        <span style="flex:1"></span><button class="btn sm" v-if="isAdmin" @click="edit(s)">设置</button></div>
        <div class="card-b"><div class="small muted" style="margin-bottom:6px">嵌入代码（放在 &lt;/body&gt; 之前）：</div>
          <div class="code">{{embed(s)}}</div>
          <div class="row" style="margin-top:10px"><button class="btn sm" @click="copy(embed(s))">复制代码</button><span class="small muted">允许域名：{{s.domains||'不限制'}}</span></div></div></div>
    </div>
    <div v-if="!list.length" class="card card-b empty">还没有站点</div>
    <Modal v-if="cur" :title="cur.id?'站点设置':'新建站点'" lg @close="cur=null">
      <div class="grid g2" style="gap:0 16px">
        <div class="field"><label>站点名称</label><input class="inp" v-model="cur.name"></div>
        <div class="field"><label>允许的域名</label><input class="inp" v-model="cur.domains" placeholder="www.example.com,example.org"><div class="hint">逗号分隔，含子域名；留空不限制</div></div>
        <div class="field"><label>窗口标题</label><input class="inp" v-model="cur.title"></div>
        <div class="field"><label>主题色</label><div class="row"><input type="color" v-model="cur.color" style="width:44px;height:34px;border:0;background:none"><input class="inp" v-model="cur.color"></div></div>
        <div class="field"><label>欢迎语</label><input class="inp" v-model="cur.welcome"></div>
        <div class="field"><label>按钮位置</label><select class="inp" v-model="cur.position"><option value="right">右下角</option><option value="left">左下角</option></select></div>
      </div>
      <div class="field"><label>离线提示</label><input class="inp" v-model="cur.offline_msg"><div class="hint">没有客服在线且 AI 未接待时自动发送，并请访客留下联系方式</div></div>
      <div class="field"><label class="row">Xboard 用户识别 <span class="switch" :class="{on:cur.xboard}" @click="cur.xboard=cur.xboard?0:1"></span></label>
        <div class="hint">开启后，已登录 Xboard 的用户会自动带上邮箱、套餐、到期时间、流量、余额（从用户浏览器读取，不改动 Xboard）</div></div>
      <div style="border-top:1px solid var(--border);margin:6px 0 14px"></div>
      <div class="grid g2" style="gap:0 16px">
        <div class="field"><label>AI 接待模式</label><select class="inp" v-model="cur.ai_mode">
          <option value="off">关闭（仅辅助客服）</option><option value="offline">客服全部离线时由 AI 接待</option><option value="always">AI 优先接待，人工随时接管</option></select>
          <div class="hint" v-if="!S.ai" style="color:var(--warn)">尚未配置 AI Key，请先到系统设置</div></div>
        <div class="field"><label>AI 名称</label><input class="inp" v-model="cur.ai_name"></div>
      </div>
      <div class="field"><label>AI 补充指令</label><textarea class="inp" v-model="cur.ai_prompt" placeholder="例如：称呼用户为'您'；涉及退款一律转人工；推荐年付套餐…"></textarea></div>
      <div class="field"><label>知识库</label><textarea class="inp" v-model="cur.knowledge" style="min-height:220px" placeholder="把常见问题、套餐说明、使用教程、客户端下载地址、售后政策等粘贴到这里。AI 只会根据这里的内容回答。"></textarea>
        <div class="hint">{{(cur.knowledge||'').length}} 字。内容越完整，AI 回答越准确；知识库没有的问题 AI 会转人工。</div></div>
      <template #foot><button class="btn dan" v-if="cur.id" @click="del" style="margin-right:auto">删除站点</button><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="save">保存</button></template>
    </Modal>
  </div>`,
  data: () => ({ S, list: [], cur: null }),
  computed: { isAdmin() { return S.user.role === 'admin'; } },
  methods: {
    embed(s) { return '<script src="' + S.apiURL + '/widget.js" data-site="' + s.site_key + '" async><\/script>'; },
    copy(t) { navigator.clipboard.writeText(t).then(() => toast('已复制')); },
    edit(s) { this.cur = Object.assign({ name: '', domains: '', color: '#0071e3', title: '在线客服', welcome: '您好，有什么可以帮您？', offline_msg: '客服暂时不在线，请留言，我们会尽快回复您。', position: 'right', ai_mode: 'off', ai_name: 'AI 助手', ai_prompt: '', knowledge: '', xboard: 0 }, s); },
    async load() { try { this.list = await api('GET', '/api/sites'); S.sites = this.list; } catch (e) { toast(e.message, true); } },
    async save() {
      try {
        if (this.cur.id) await api('PUT', '/api/sites/' + this.cur.id, this.cur); else await api('POST', '/api/sites', this.cur);
        this.cur = null; toast('已保存'); this.load();
      } catch (e) { toast(e.message, true); }
    },
    async del() {
      if (prompt('删除站点会同时删除它的所有访客和会话记录。输入站点名称确认：') !== this.cur.name) return;
      try { await api('DELETE', '/api/sites/' + this.cur.id); this.cur = null; this.load(); } catch (e) { toast(e.message, true); }
    },
  },
  mounted() { this.load(); },
};

const Canned = {
  components: { Modal },
  template: `<div class="card"><div class="card-h">快捷回复 <span class="small muted" style="font-weight:400">在回复框输入 / 调出，支持 {name} {email} 变量</span><span style="flex:1"></span><button class="btn pri" @click="cur={shortcut:'',body:''}"><Icon n="plus" :s="16"/>新增</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th style="width:160px">快捷词</th><th>内容</th><th style="width:120px"></th></tr></thead><tbody>
      <tr v-for="c in S.canned" :key="c.id"><td><b>/{{c.shortcut}}</b></td><td style="white-space:pre-wrap">{{c.body}}</td>
        <td><button class="btn sm" @click="cur={...c}">编辑</button> <button class="btn sm dan" @click="del(c)">删除</button></td></tr>
      <tr v-if="!S.canned.length"><td colspan="3" class="empty">暂无快捷回复</td></tr></tbody></table></div>
    <Modal v-if="cur" title="快捷回复" @close="cur=null">
      <div class="field"><label>快捷词</label><input class="inp" v-model="cur.shortcut" placeholder="例如 ios"></div>
      <div class="field"><label>内容</label><textarea class="inp" v-model="cur.body" style="min-height:140px"></textarea></div>
      <template #foot><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="save">保存</button></template></Modal>
  </div>`,
  data: () => ({ S, cur: null }),
  methods: {
    async load() { S.canned = await api('GET', '/api/canned'); },
    async save() {
      try { if (this.cur.id) await api('PUT', '/api/canned/' + this.cur.id, this.cur); else await api('POST', '/api/canned', this.cur); this.cur = null; this.load(); } catch (e) { toast(e.message, true); }
    },
    async del(c) { if (!confirm('删除 /' + c.shortcut + '？')) return; await api('DELETE', '/api/canned/' + c.id); this.load(); },
  },
};

const Agents = {
  components: { Modal, Avatar },
  template: `<div class="card"><div class="card-h">客服成员<span style="flex:1"></span><button class="btn pri" @click="cur={email:'',name:'',password:'',role:'agent'}"><Icon n="plus" :s="16"/>添加成员</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>最后在线</th><th></th></tr></thead><tbody>
      <tr v-for="u in list" :key="u.id"><td><div class="row"><Avatar :name="u.name" :online="u.online" small /><div>{{u.name}}<div class="small muted">{{u.email}}</div></div></div></td>
        <td><span class="tag" :class="u.role==='admin'?'blue':''">{{u.role==='admin'?'管理员':'客服'}}</span></td>
        <td><span class="tag red" v-if="u.disabled">已停用</span><span v-else class="small">{{u.online?'在线':'离线'}}</span></td>
        <td class="small">{{fmtTime(u.last_seen)}}</td>
        <td><button class="btn sm" @click="cur={...u,password:''}">编辑</button> <button class="btn sm dan" v-if="u.id!==S.user.id" @click="del(u)">删除</button></td></tr>
    </tbody></table></div>
    <Modal v-if="cur" :title="cur.id?'编辑成员':'添加成员'" @close="cur=null">
      <div class="field"><label>邮箱</label><input class="inp" v-model="cur.email" :disabled="!!cur.id"></div>
      <div class="field"><label>名称</label><input class="inp" v-model="cur.name"></div>
      <div class="field"><label>{{cur.id?'重置密码（留空不修改）':'密码'}}</label><input class="inp" type="text" v-model="cur.password" placeholder="至少 8 位"></div>
      <div class="field" v-if="cur.id!==S.user.id"><label>角色</label><select class="inp" v-model="cur.role"><option value="agent">客服</option><option value="admin">管理员</option></select></div>
      <div class="field" v-if="cur.id && cur.id!==S.user.id"><label class="row">停用账号 <span class="switch" :class="{on:cur.disabled}" @click="cur.disabled=cur.disabled?0:1"></span></label></div>
      <template #foot><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="save">保存</button></template></Modal>
  </div>`,
  data: () => ({ S, list: [], cur: null }),
  methods: {
    fmtTime,
    async load() { this.list = await api('GET', '/api/users'); },
    async save() {
      try {
        if (this.cur.id) await api('PUT', '/api/users/' + this.cur.id, { name: this.cur.name, role: this.cur.role, disabled: !!this.cur.disabled, password: this.cur.password });
        else await api('POST', '/api/users', this.cur);
        this.cur = null; this.load(); toast('已保存');
        const b = await api('GET', '/api/bootstrap'); S.users = b.users;
      } catch (e) { toast(e.message, true); }
    },
    async del(u) { if (!confirm('删除成员 ' + u.name + '？')) return; try { await api('DELETE', '/api/users/' + u.id); this.load(); } catch (e) { toast(e.message, true); } },
  },
  mounted() { this.load(); },
};

const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 · 推荐（聪明，价格适中）'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 · 均衡（更快，约半价）'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 · 最快最便宜'],
  ['claude-fable-5-1', 'Claude Fable 5.1 · 最强（最贵）'],
];

// ---- 系统设置 → 系统声音设置（可展开收起）----
const SoundSettings = {
  components: { Modal },
  template: `<div class="card fold" :class="{open}"><div class="card-h fold-h" @click="open=!open">
      <span class="fold-arrow">▸</span>系统声音设置<span style="flex:1"></span>
      <span class="small muted" style="font-weight:400">默认：{{soundLabel(S.soundDefault)}} · 已上传 {{S.sounds.length}} 个</span></div>
    <div class="card-b" v-if="open">
      <div class="hint" style="margin:0 0 12px">从电脑上传提示音（mp3 / m4a / wav / ogg，最大 2MB，建议 1–3 秒）。设为默认后，所有客服没有单独选择时都会听到这个声音；客服也可以在「个人设置」里自己选。</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>默认</th><th>名称</th><th>大小</th><th>更新时间</th><th></th></tr></thead><tbody>
        <tr v-for="x in S.sounds" :key="x.id">
          <td><input type="radio" :checked="S.soundDefault==='s:'+x.id" @change="setDefault('s:'+x.id)"></td>
          <td>{{x.name}}</td><td class="small">{{kb(x.size)}}</td><td class="small">{{fmtTime(x.updated_at)}}</td>
          <td style="white-space:nowrap"><button class="btn sm" @click="playSound('s:'+x.id)">试听</button>
            <button class="btn sm" @click="edit(x)">修改</button>
            <button class="btn sm dan" @click="del(x)">删除</button></td></tr>
        <tr v-for="b in SOUNDS" :key="b[0]">
          <td><input type="radio" :checked="S.soundDefault===b[0]" @change="setDefault(b[0])"></td>
          <td>{{b[1]}} <span class="tag">内置</span></td><td class="small muted">-</td><td class="small muted">-</td>
          <td><button class="btn sm" @click="playSound(b[0])">试听</button></td></tr>
      </tbody></table></div>
      <div class="row" style="margin-top:14px;flex-wrap:wrap">
        <input class="inp" v-model="newName" placeholder="声音名称（可选，默认用文件名）" style="max-width:240px">
        <input type="file" ref="file" accept=".mp3,.m4a,.wav,.ogg,audio/*" style="max-width:240px">
        <label class="small row" style="gap:6px"><input type="checkbox" v-model="makeDefault">设为默认</label>
        <button class="btn pri" @click="upload" :disabled="busy">{{busy?'上传中…':'上传提示音'}}</button></div>
    </div>
    <Modal v-if="cur" title="修改提示音" @close="cur=null">
      <div class="field"><label>名称</label><input class="inp" v-model="cur.name"></div>
      <div class="field"><label>替换声音文件（不选则只改名称）</label><input type="file" ref="rfile" accept=".mp3,.m4a,.wav,.ogg,audio/*"></div>
      <template #foot><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="saveEdit" :disabled="busy">保存</button></template></Modal>
  </div>`,
  data: () => ({ S, SOUNDS, open: false, newName: '', makeDefault: false, busy: false, cur: null }),
  methods: {
    fmtTime, playSound, soundLabel,
    kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; },
    apply(r) { S.sounds = r.sounds || []; S.soundDefault = r.default || 'turn'; },
    pick(input) {
      const f = input && input.files && input.files[0];
      if (!f) return null;
      if (f.size > 2 * 1024 * 1024) { toast('声音文件不能超过 2MB', true); return false; }
      return f;
    },
    async upload() {
      const f = this.pick(this.$refs.file);
      if (f === null) return toast('请先选择声音文件', true);
      if (!f) return;
      const fd = new FormData(); fd.append('file', f); fd.append('name', this.newName.trim()); if (this.makeDefault) fd.append('make_default', '1');
      this.busy = true;
      try { this.apply(await api('POST', '/api/sounds', fd)); this.newName = ''; this.makeDefault = false; this.$refs.file.value = ''; toast('已上传'); }
      catch (e) { toast(e.message, true); }
      this.busy = false;
    },
    edit(x) { this.cur = { id: x.id, name: x.name }; },
    async saveEdit() {
      const f = this.pick(this.$refs.rfile);
      if (f === false) return;
      const fd = new FormData(); fd.append('name', this.cur.name.trim()); if (f) fd.append('file', f);
      this.busy = true;
      try { this.apply(await api('PUT', '/api/sounds/' + this.cur.id, fd)); this.cur = null; toast('已保存'); }
      catch (e) { toast(e.message, true); }
      this.busy = false;
    },
    async del(x) {
      if (!confirm('删除提示音「' + x.name + '」？正在使用它的客服会自动改用系统默认声音。')) return;
      try { this.apply(await api('DELETE', '/api/sounds/' + x.id)); toast('已删除'); } catch (e) { toast(e.message, true); }
    },
    async setDefault(k) {
      try { await api('PUT', '/api/settings', { sound_default: k }); S.soundDefault = k; toast('已设为默认：' + soundLabel(k)); playSound(k); }
      catch (e) { toast(e.message, true); }
    },
  },
};

const Settings = {
  components: { SoundSettings },
  template: `<div style="max-width:720px">
    <SoundSettings style="margin-bottom:16px" />
    <div class="card"><div class="card-h">AI 设置 <span style="flex:1"></span><span class="tag blue">{{protoLabel}}</span></div><div class="card-b">
      <div class="field"><label>接口地址</label><input class="inp" v-model="f.ai_base_url" placeholder="留空 = Claude 官方接口">
        <div class="hint">用中转站（比如 sub2api）就填中转站地址，后面带不带 /v1 都可以</div></div>
      <div class="field"><label>API Key</label><input class="inp" type="password" v-model="f.ai_api_key" :placeholder="f.ai_key_hint||'sk-…'" autocomplete="off">
        <div class="hint">{{f.ai_key_hint ? f.ai_key_hint + '，留空保持不变，填 - 清除' : '填官方或中转站给你的 Key'}}</div></div>
      <div class="field"><label>模型</label>
        <div class="row"><select class="inp" v-model="modelSel">
          <optgroup label="Claude 模型（推荐）"><option v-for="m in CLAUDE_MODELS" :key="m[0]" :value="m[0]">{{m[1]}}</option></optgroup>
          <optgroup label="Claude 模型（中转站提供）" v-if="extraClaude.length"><option v-for="m in extraClaude" :key="m" :value="m">{{m}}</option></optgroup>
          <optgroup label="GPT / 其他模型" v-if="others.length"><option v-for="m in others" :key="m" :value="m">{{m}}</option></optgroup>
          <option value="__custom">✏️ 手动输入模型名…</option>
        </select><button class="btn" @click="fetchModels" :disabled="fetching">{{fetching?'获取中…':'获取模型列表'}}</button></div>
        <input class="inp" v-if="modelSel==='__custom'" v-model="customModel" placeholder="输入模型名，例如 gpt-6-sol" style="margin-top:8px">
        <div class="hint">{{fetchMsg || '点「获取模型列表」会读取中转站支持的全部模型（Claude 和 GPT 都会列出来）'}}</div></div>
      <div class="grid g2" style="gap:0 16px">
        <div class="field"><label>接口协议</label><select class="inp" v-model="f.ai_provider">
          <option value="">自动识别（推荐）</option><option value="anthropic">Claude 协议</option><option value="openai">OpenAI / GPT 协议</option></select>
          <div class="hint">自动识别：模型名以 claude 开头用 Claude 协议，其他用 OpenAI 协议</div></div>
        <div class="field"><label>思考强度</label><select class="inp" v-model="f.ai_effort"><option value="">low（默认，回复最快）</option><option value="medium">medium（更仔细）</option><option value="high">high（最准确，较慢较贵）</option></select></div>
      </div>
      <div class="row"><button class="btn pri" @click="save">保存</button><button class="btn" @click="test" :disabled="testing">{{testing?'测试中…':'测试连接'}}</button><span class="small muted">{{testMsg}}</span></div>
    </div></div>
    <div class="card" style="margin-top:16px"><div class="card-h">Telegram 互通 <span style="flex:1"></span>
      <span class="tag" :class="tg.running?'green':(tg.configured?'red':'')">{{tg.running ? '运行中 @' + tg.bot : (tg.configured ? '异常' : '未配置')}}</span></div><div class="card-b">
      <div class="field"><label>Bot Token</label><input class="inp" type="password" v-model="f.tg_bot_token" :placeholder="f.tg_token_hint||'123456:ABC…'" autocomplete="off">
        <div class="hint">{{f.tg_token_hint ? f.tg_token_hint + '，留空保持不变，填 - 清除' : '在 @BotFather 创建一个专用机器人'}}</div>
        <div class="hint" v-if="tg.error" style="color:var(--danger)">{{tg.error}}</div></div>
      <div class="field"><label>客服接待群（可选）</label><select class="inp" v-model="f.tg_support_chat_id"><option value="">不使用</option>
        <option v-for="c in tg.chats||[]" :value="c.id">{{c.title}}（{{c.id}}）{{c.is_forum?' · 话题模式':' · 普通群（建议开启话题）'}}</option></select>
        <div class="hint">网页客服的每个会话会自动在这个群建立一个话题，客服可以直接在 TG 回复访客，发送 /close 结束会话，/note 写内部备注</div></div>
      <div class="field"><label>机器人发现的群组</label>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>群组</th><th>Chat ID</th><th>类型</th></tr></thead><tbody>
          <tr v-for="c in tg.chats||[]" :key="c.id"><td>{{c.title}}</td><td><code>{{c.id}}</code></td><td>{{c.is_forum?'话题群':c.type}}</td></tr>
          <tr v-if="!(tg.chats||[]).length"><td colspan="3" class="empty">还没有群组。把机器人拉进群并在群里发一条消息，然后点刷新</td></tr></tbody></table></div></div>
      <div class="row"><button class="btn pri" @click="saveTG">保存</button><button class="btn" @click="loadTG">刷新</button></div>
      <ol class="small muted" style="margin:14px 0 0;padding-left:18px;line-height:1.9">
        <li>在 Telegram 找 @BotFather → /newbot 创建机器人，复制 Token 填到上面</li>
        <li>@BotFather → /setprivacy → 选择机器人 → Disable（机器人才能看到群里所有消息）</li>
        <li>把机器人拉进 3 个群并设为管理员（需要“删除消息”权限；客服接待群还需要“管理话题”权限）</li>
        <li>在每个群里随便发一条消息，回来点「刷新」就能看到群组</li>
        <li>社区群聊 → 群设置 → 「互通 Telegram 群组」选择对应的群</li>
      </ol>
    </div></div>
  </div>`,
  data: () => ({ f: {}, testing: false, testMsg: '', tg: {}, CLAUDE_MODELS, models: [], modelSel: 'claude-opus-5-5', customModel: '', fetching: false, fetchMsg: '' }),
  computed: {
    known() { return CLAUDE_MODELS.map(m => m[0]); },
    // fetched models plus the currently saved one, minus the presets
    pool() { const l = [...this.models]; if (this.f.ai_model && !l.includes(this.f.ai_model)) l.push(this.f.ai_model); return l.filter(m => !this.known.includes(m)); },
    extraClaude() { return this.pool.filter(m => /^claude/i.test(m)); },
    others() { return this.pool.filter(m => !/^claude/i.test(m)); },
    chosen() { return this.modelSel === '__custom' ? this.customModel.trim() : this.modelSel; },
    protoLabel() {
      const p = this.f.ai_provider || (/^claude/i.test(this.chosen) ? 'anthropic' : 'openai');
      return p === 'anthropic' ? '使用 Claude 协议' : '使用 OpenAI / GPT 协议';
    },
  },
  methods: {
    async load() {
      this.f = await api('GET', '/api/settings'); this.loadTG();
      this.modelSel = this.f.ai_model || 'claude-opus-5-5';
    },
    async fetchModels() {
      this.fetching = true; this.fetchMsg = '';
      try {
        const r = await api('POST', '/api/settings/ai-models', { ai_base_url: this.f.ai_base_url || '', ai_api_key: this.f.ai_api_key || '' });
        this.models = r.models; this.fetchMsg = '✅ 获取到 ' + r.models.length + ' 个模型，请在上面的下拉框里选择';
      } catch (e) { this.fetchMsg = '❌ ' + e.message; }
      this.fetching = false;
    },
    async loadTG() { try { this.tg = await api('GET', '/api/telegram/status'); } catch (e) {} },
    async save() {
      if (this.modelSel === '__custom' && !this.customModel.trim()) return toast('请输入模型名', true);
      this.f.ai_model = this.chosen;
      try {
        this.f = await api('PUT', '/api/settings', this.f); S.ai = !!this.f.ai_key_hint; toast('已保存');
        this.modelSel = this.f.ai_model || 'claude-opus-5-5';
      } catch (e) { toast(e.message, true); }
    },
    async saveTG() {
      try {
        this.f = await api('PUT', '/api/settings', { tg_bot_token: this.f.tg_bot_token || '', tg_support_chat_id: this.f.tg_support_chat_id || '', console_url: location.origin + location.pathname.replace(/\/$/, '') });
        toast('已保存'); setTimeout(() => this.loadTG(), 2500);
      } catch (e) { toast(e.message, true); }
    },
    async test() {
      this.testing = true; this.testMsg = '';
      try { await this.save(); const r = await api('POST', '/api/settings/ai-test'); this.testMsg = '✅ ' + r.text; } catch (e) { this.testMsg = '❌ ' + e.message; }
      this.testing = false;
    },
  },
  mounted() { this.load(); },
};

// ---- 邮件插件：写邮件弹窗（会话、访客记录、插件页都能用）----
const MailCompose = {
  components: { Modal },
  props: ['to', 'visitorId', 'convId', 'name'],
  emits: ['close', 'sent'],
  template: `<Modal title="发送邮件" lg @close="$emit('close')">
    <div v-if="!senders.length && loaded" class="hint" style="color:var(--warn)">还没有发件邮箱，请管理员到「插件管理 → 邮件插件」添加。</div>
    <div class="grid g2" style="gap:0 16px">
      <div class="field"><label>发件邮箱</label><select class="inp" v-model="f.sender_id">
        <option v-for="x in senders" :key="x.id" :value="x.id">{{x.from_name ? x.from_name + ' <' + x.from_addr + '>' : x.from_addr}}{{x.is_default?'（默认）':''}}</option></select></div>
      <div class="field"><label>收件地址</label><input class="inp" v-model="f.to" placeholder="客户邮箱"></div>
    </div>
    <div class="field"><label>主题</label><input class="inp" v-model="f.subject" placeholder="例如：关于您的咨询"></div>
    <div class="field"><label>正文</label><textarea class="inp" v-model="f.body" style="min-height:200px" placeholder="邮件内容，换行会保留"></textarea></div>
    <template #foot><button class="btn" @click="$emit('close')">取消</button><button class="btn pri" @click="send" :disabled="busy||!senders.length">{{busy?'发送中…':'发送'}}</button></template>
  </Modal>`,
  data() { return { senders: [], loaded: false, busy: false,
    f: { sender_id: 0, to: this.to || '', subject: '', body: (this.name ? this.name + '，您好：\n\n' : '您好：\n\n') + '\n\n' + (S.user ? S.user.name : '') } }; },
  methods: {
    async send() {
      if (!this.f.to.trim() || !this.f.subject.trim() || !this.f.body.trim()) return toast('请填写收件地址、主题和正文', true);
      this.busy = true;
      try {
        await api('POST', '/api/mail/send', { ...this.f, visitor_id: this.visitorId || '', conversation_id: this.convId || 0 });
        toast('邮件已发送'); this.$emit('sent'); this.$emit('close');
      } catch (e) { toast(e.message, true); }
      this.busy = false;
    },
  },
  async mounted() {
    try { this.senders = await api('GET', '/api/mail/senders'); const d = this.senders.find(x => x.is_default) || this.senders[0]; if (d) this.f.sender_id = d.id; } catch (e) { toast(e.message, true); }
    this.loaded = true;
  },
};

// ---- 插件管理 ----
const MAIL_SEC = { ssl: 'SSL/TLS（一般是 465 端口）', starttls: 'STARTTLS（一般是 587 端口）', none: '不加密（一般是 25 端口）' };
const Plugins = {
  components: { Modal, MailCompose },
  template: `<div style="max-width:960px">
    <div class="card" v-for="p in list" :key="p.code" style="margin-bottom:16px">
      <div class="card-h"><span style="font-size:20px">{{p.icon}}</span>{{p.name}} <span class="tag">v{{p.version}}</span>
        <span class="tag" :class="p.enabled?'green':''">{{p.enabled?'已启用':'未启用'}}</span><span style="flex:1"></span>
        <span class="switch" :class="{on:p.enabled}" @click="toggle(p)" :title="p.enabled?'点击停用':'点击启用'"></span></div>
      <div class="card-b">
        <div class="small muted" style="line-height:1.8">{{p.description}}</div>
        <template v-if="p.code==='mail' && p.enabled">
          <div class="row" style="margin:16px 0 8px"><b>发件邮箱</b><span style="flex:1"></span>
            <button class="btn" @click="compose=true" :disabled="!senders.length">✉️ 写邮件</button>
            <button class="btn pri" @click="cur={name:'',host:'',port:465,security:'ssl',username:'',password:'',from_addr:'',from_name:'',is_default:false}"><Icon n="plus" :s="16"/>添加发件邮箱</button></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>名称</th><th>发件地址</th><th>SMTP 服务器</th><th>加密</th><th></th></tr></thead><tbody>
            <tr v-for="x in senders" :key="x.id"><td>{{x.name}} <span class="tag blue" v-if="x.is_default">默认</span></td>
              <td>{{x.from_name ? x.from_name + ' <' + x.from_addr + '>' : x.from_addr}}</td>
              <td class="small">{{x.host}}:{{x.port}}</td><td class="small">{{(MAIL_SEC[x.security]||'').split('（')[0]}}</td>
              <td style="white-space:nowrap"><button class="btn sm" @click="testIt(x)">测试</button>
                <button class="btn sm" @click="cur={...x,password:''}">修改</button>
                <button class="btn sm dan" @click="del(x)">删除</button></td></tr>
            <tr v-if="!senders.length"><td colspan="5" class="empty">还没有发件邮箱，点右上角「添加发件邮箱」</td></tr></tbody></table></div>
          <div class="row" style="margin:20px 0 8px"><b>发送记录</b><span class="small muted">最近 100 封</span></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>收件人</th><th>主题</th><th>发件人</th><th>客服</th><th>结果</th><th></th></tr></thead><tbody>
            <tr v-for="l in logs" :key="l.id"><td class="small">{{fmtTime(l.created_at)}}</td><td>{{l.to_addr}}</td>
              <td><a href="javascript:" @click="view=l">{{l.subject}}</a></td><td class="small">{{l.from_addr}}</td><td class="small">{{l.user_name}}</td>
              <td><span class="tag green" v-if="l.status==='ok'">成功</span><span class="tag red" v-else :title="l.error">失败</span></td>
              <td><button class="btn sm dan" @click="delLog(l)">删除</button></td></tr>
            <tr v-if="!logs.length"><td colspan="7" class="empty">还没有发送记录</td></tr></tbody></table></div>
        </template>
      </div>
    </div>
    <Modal v-if="cur" :title="cur.id?'修改发件邮箱':'添加发件邮箱'" lg @close="cur=null">
      <div class="grid g2" style="gap:0 16px">
        <div class="field"><label>名称（自己看的）</label><input class="inp" v-model="cur.name" placeholder="例如：客服邮箱"></div>
        <div class="field"><label>发件人名称（客户看到的）</label><input class="inp" v-model="cur.from_name" placeholder="例如：Koyun 客服"></div>
        <div class="field"><label>发件地址</label><input class="inp" v-model="cur.from_addr" placeholder="support@example.com"></div>
        <div class="field"><label>SMTP 服务器</label><input class="inp" v-model="cur.host" placeholder="smtp.example.com"></div>
        <div class="field"><label>加密方式</label><select class="inp" v-model="cur.security" @change="autoPort"><option v-for="(t,k) in MAIL_SEC" :value="k">{{t}}</option></select></div>
        <div class="field"><label>端口</label><input class="inp" type="number" v-model.number="cur.port"></div>
        <div class="field"><label>登录用户名</label><input class="inp" v-model="cur.username" placeholder="一般就是发件地址" autocomplete="off"></div>
        <div class="field"><label>密码 / 授权码</label><input class="inp" type="password" v-model="cur.password" autocomplete="new-password" :placeholder="cur.id ? (cur.has_password ? '已设置，留空不修改，填 - 清除' : '未设置') : 'QQ、163 等邮箱要填授权码'"></div>
      </div>
      <label class="row small" style="gap:6px"><input type="checkbox" v-model="cur.is_default">设为默认发件邮箱</label>
      <template #foot><button class="btn" @click="cur=null">取消</button><button class="btn pri" @click="save">保存</button></template></Modal>
    <Modal v-if="tester" title="发送测试邮件" @close="tester=null">
      <div class="field"><label>用 {{tester.from_addr}} 发一封测试邮件到</label><input class="inp" v-model="testTo" placeholder="你自己的邮箱"></div>
      <div class="hint">{{testMsg}}</div>
      <template #foot><button class="btn" @click="tester=null">关闭</button><button class="btn pri" @click="runTest" :disabled="testing">{{testing?'发送中…':'发送测试'}}</button></template></Modal>
    <Modal v-if="view" :title="view.subject" lg @close="view=null">
      <div class="small muted" style="margin-bottom:10px">{{view.from_addr}} → {{view.to_addr}} · {{fmtTime(view.created_at)}} · {{view.user_name}}</div>
      <div v-if="view.error" class="hint" style="color:var(--danger);margin-bottom:10px">失败原因：{{view.error}}</div>
      <div style="white-space:pre-wrap;line-height:1.7">{{view.body}}</div></Modal>
    <MailCompose v-if="compose" @close="compose=false" @sent="loadLogs" />
  </div>`,
  data: () => ({ S, MAIL_SEC, list: [], senders: [], logs: [], cur: null, tester: null, testTo: '', testMsg: '', testing: false, view: null, compose: false }),
  methods: {
    fmtTime,
    async load() {
      this.list = await api('GET', '/api/plugins');
      const m = this.list.find(p => p.code === 'mail');
      if (m && m.enabled) { this.senders = await api('GET', '/api/mail/senders'); this.loadLogs(); }
    },
    async loadLogs() { try { this.logs = await api('GET', '/api/mail/logs'); } catch (e) {} },
    async toggle(p) {
      try { this.list = await api('PUT', '/api/plugins/' + p.code, { enabled: !p.enabled }); S.plugins[p.code] = !p.enabled; toast(p.enabled ? '已停用' : '已启用'); this.load(); }
      catch (e) { toast(e.message, true); }
    },
    autoPort() { this.cur.port = { ssl: 465, starttls: 587, none: 25 }[this.cur.security]; },
    async save() {
      const c = this.cur;
      if (!c.from_addr.trim() || !c.host.trim()) return toast('请填写发件地址和 SMTP 服务器', true);
      try {
        this.senders = await api(c.id ? 'PUT' : 'POST', '/api/mail/senders' + (c.id ? '/' + c.id : ''),
          { name: c.name, host: c.host.trim(), port: Number(c.port), security: c.security, username: c.username.trim(), password: c.password, from_addr: c.from_addr.trim(), from_name: c.from_name, is_default: !!c.is_default });
        this.cur = null; toast('已保存，建议点「测试」确认能发出去');
      } catch (e) { toast(e.message, true); }
    },
    async del(x) {
      if (!confirm('删除发件邮箱 ' + x.from_addr + '？')) return;
      try { this.senders = await api('DELETE', '/api/mail/senders/' + x.id); toast('已删除'); } catch (e) { toast(e.message, true); }
    },
    testIt(x) { this.tester = x; this.testMsg = ''; this.testTo = this.testTo || (S.user && S.user.email) || ''; },
    async runTest() {
      this.testing = true; this.testMsg = '';
      try { await api('POST', '/api/mail/senders/' + this.tester.id + '/test', { to: this.testTo }); this.testMsg = '✅ 已发出，请到收件箱（或垃圾邮件箱）查看'; }
      catch (e) { this.testMsg = '❌ ' + e.message; }
      this.testing = false;
    },
    async delLog(l) {
      if (!confirm('删除这条发送记录？')) return;
      try { await api('DELETE', '/api/mail/logs/' + l.id); this.loadLogs(); } catch (e) { toast(e.message, true); }
    },
  },
  mounted() { this.load().catch(e => toast(e.message, true)); },
};

const Profile = {
  template: `<div style="max-width:520px"><div class="card"><div class="card-h">个人资料</div><div class="card-b">
    <div class="field"><label>名称（访客看到的客服名）</label><input class="inp" v-model="name"></div>
    <div class="field"><label>原密码</label><input class="inp" type="password" v-model="oldp" autocomplete="current-password"></div>
    <div class="field"><label>新密码（留空不修改）</label><input class="inp" type="password" v-model="newp" autocomplete="new-password"></div>
    <div class="field"><label class="row">消息提示音 <span class="switch" :class="{on:S.sound}" @click="toggleSound"></span></label></div>
    <div class="field" v-if="S.sound"><label>提示音样式</label><div class="row">
      <select class="inp" v-model="S.soundKind" @change="saveSound(true)">
        <option value="">跟随系统默认（{{soundLabel(S.soundDefault)}}）</option>
        <optgroup label="上传的提示音" v-if="S.sounds.length"><option v-for="x in S.sounds" :key="x.id" :value="'s:'+x.id">{{x.name}}</option></optgroup>
        <optgroup label="内置提示音"><option v-for="s in SOUNDS" :value="s[0]">{{s[1]}}</option></optgroup></select>
      <button class="btn" @click="playSound(S.soundKind)">试听</button></div>
      <div class="hint">管理员可以在 系统设置 → 系统声音设置 上传新的提示音</div></div>
    <div class="field" v-if="S.sound"><label>音量 {{S.volume}}%</label>
      <input type="range" min="10" max="100" step="5" v-model.number="S.volume" @change="saveSound(true)" style="width:100%"></div>
    <div class="field"><label>外观</label><select class="inp" v-model="S.theme" @change="theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div>
    <button class="btn pri" @click="save">保存</button></div></div></div>`,
  data: () => ({ S, SOUNDS, name: S.user.name, oldp: '', newp: '' }),
  methods: {
    playSound, soundLabel,
    saveSound(preview) {
      localStorage.setItem('kc_sound_kind', S.soundKind); localStorage.setItem('kc_volume', String(S.volume));
      if (preview) playSound(S.soundKind);
    },
    toggleSound() { S.sound = !S.sound; localStorage.setItem('kc_sound', S.sound ? '1' : '0'); if (S.sound) beep(); },
    theme() { localStorage.setItem('kc_theme', S.theme); applyTheme(); },
    async save() {
      try { S.user = await api('PUT', '/api/me', { Name: this.name, OldPassword: this.oldp, NewPassword: this.newp }); this.oldp = this.newp = ''; toast('已保存'); } catch (e) { toast(e.message, true); }
    },
  },
};

const VIEWS = {
  dashboard: ['仪表盘', Dashboard], visitors: ['实时访客', Visitors], inbox: ['会话', Inbox], team: ['团队协作', Team],
  history: ['访客记录', History], sites: ['站点管理', Sites], canned: ['快捷回复', Canned], agents: ['客服成员', Agents],
  settings: ['系统设置', Settings], profile: ['个人设置', Profile], community: ['社区群聊', Community],
  plugins: ['插件管理', Plugins],
};
VisitorPanel.components.MailCompose = MailCompose;

const App = {
  components: { Login, Avatar },
  template: `<div class="toast"><div v-for="t in S.toasts" :key="t.id" :class="{err:t.err}">{{t.msg}}</div></div>
  <Login v-if="!S.user" />
  <div v-else class="layout">
    <aside class="side" :class="{show:S.sideOpen}">
      <div class="brand"><i><Icon n="chat" :s="18" :w="2"/></i>Koyun Chat</div>
      <nav class="nav">
        <div class="grp">接待</div>
        <a href="#/dashboard" :class="{on:r==='dashboard'}"><Icon n="grid"/>仪表盘</a>
        <a href="#/visitors" :class="{on:r==='visitors'}"><Icon n="live"/>实时访客<span class="cnt gray">{{liveCount}}</span></a>
        <a href="#/inbox" :class="{on:r==='inbox'}"><Icon n="chats"/>会话<span class="cnt" v-if="convUnread">{{convUnread}}</span></a>
        <a href="#/history" :class="{on:r==='history'}"><Icon n="clock"/>访客记录</a>
        <div class="grp">办公</div>
        <a href="#/team" :class="{on:r==='team'}"><Icon n="people"/>团队协作<span class="cnt" v-if="teamUnread">{{teamUnread}}</span></a>
        <a href="#/community" :class="{on:r==='community'}"><Icon n="globe"/>社区群聊</a>
        <a href="#/canned" :class="{on:r==='canned'}"><Icon n="bolt"/>快捷回复</a>
        <template v-if="S.user.role==='admin'">
          <div class="grp">管理</div>
          <a href="#/sites" :class="{on:r==='sites'}"><Icon n="display"/>站点管理</a>
          <a href="#/agents" :class="{on:r==='agents'}"><Icon n="person"/>客服成员</a>
          <a href="#/plugins" :class="{on:r==='plugins'}"><Icon n="badge"/>插件管理</a>
          <a href="#/settings" :class="{on:r==='settings'}"><Icon n="gear"/>系统设置</a>
        </template>
      </nav>
      <div class="me"><Avatar :name="S.user.name" :online="S.wsOn" small /><a class="n" href="#/profile">{{S.user.name}}</a><button title="退出登录" @click="logout"><Icon n="logout" :s="18"/></button></div>
    </aside>
    <div class="main">
      <header class="top"><button class="btn sm ghost mob-only" @click="S.sideOpen=!S.sideOpen"><Icon n="menu"/></button><h1>{{title}}</h1><span class="sp"></span>
        <span class="conn"><span class="dot" :class="{on:S.wsOn}"></span>{{S.wsOn?'已连接':'连接中…'}}</span></header>
      <component :is="view" v-if="flush" :key="r" />
      <div v-else class="content"><component :is="view" :key="r" /></div>
    </div>
  </div>`,
  data: () => ({ S }),
  computed: {
    r() { return VIEWS[S.route.name] ? S.route.name : 'dashboard'; },
    view() { return VIEWS[this.r][1]; },
    title() { return VIEWS[this.r][0]; },
    flush() { return this.r === 'inbox' || this.r === 'team' || this.r === 'community'; },
    liveCount() { return Object.keys(S.live).length; },
    convUnread() { return S.convs.reduce((a, c) => a + (c.unread || 0), 0); },
    teamUnread() { return S.channels.reduce((a, c) => a + (c.unread || 0), 0); },
  },
  methods: { logout },
};

createApp(App).component('Icon', Icon).mount('#app');
if (S.token) bootstrap().catch(e => { console.error(e); });
