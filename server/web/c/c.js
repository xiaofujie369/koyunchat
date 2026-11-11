/* Koyun community web chat (customer side) */
const { createApp, reactive, nextTick } = Vue;

const S = reactive({
  token: localStorage.getItem('kc_m_token') || '', me: null, brand: '社区群聊',
  joined: [], publicRooms: [], route: { name: 'home', arg: '' },
  room: null, msgs: [], members: [], toast: null, wsOn: false,
});

async function api(method, path, body) {
  const opt = { method, headers: { Authorization: 'Bearer ' + S.token } };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opt);
  let d = null; try { d = await r.json(); } catch (e) {}
  if (r.status === 401 && path !== '/api/m/login') { signOut(); throw new Error('请重新登录'); }
  if (!r.ok) throw new Error((d && d.error) || '请求失败');
  return d;
}
let toastT = null;
function toast(msg, err) { S.toast = { msg, err }; clearTimeout(toastT); toastT = setTimeout(() => S.toast = null, err ? 4000 : 2200); }
function signOut() { S.token = ''; S.me = null; localStorage.removeItem('kc_m_token'); if (ws) { ws.onclose = null; ws.close(); } }

const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#ca8a04'];
const colorOf = s => { s = String(s); let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function shortTime(t) {
  if (!t) return '';
  const d = new Date(t), n = new Date();
  return d.toDateString() === n.toDateString() ? hm(t) : (d.getMonth() + 1) + '/' + d.getDate();
}
const dayLabel = t => { const d = new Date(t), n = new Date(); if (d.toDateString() === n.toDateString()) return '今天'; return (d.getMonth() + 1) + '月' + d.getDate() + '日'; };

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

// ---------- realtime ----------
let ws = null, retry = 0;
function connect() {
  if (!S.token) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/member?token=' + encodeURIComponent(S.token));
  ws.onopen = () => { S.wsOn = true; retry = 0; loadRooms(); if (S.room) reloadMsgs(); };
  ws.onclose = () => { S.wsOn = false; ws = null; setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, retry++))); };
  ws.onmessage = ev => {
    const e = JSON.parse(ev.data), d = e.data;
    if (e.type === 'room_message') {
      if (S.room && d.room_id === S.room.id) {
        const i = S.msgs.findIndex(m => m.id === d.id);
        if (i >= 0) S.msgs.splice(i, 1, d); else { S.msgs.push(d); markRead(); }
      }
      const r = S.joined.find(x => x.id === d.room_id);
      if (r) {
        r.last_msg = d.deleted ? '消息已删除' : (d.sender_name ? d.sender_name + ': ' : '') + (d.body || '[文件]');
        r.last_at = d.created_at;
        if (!(S.room && S.room.id === d.room_id) && !(d.sender_kind === 'member' && d.sender_id === S.me.id) && d.sender_kind !== 'system') r.unread = (r.unread || 0) + 1;
        S.joined.sort((a, b) => b.last_at - a.last_at);
      }
    } else if (e.type === 'room_message_deleted') {
      const m = S.msgs.find(x => x.id === d.id); if (m) { m.deleted = 1; m.body = ''; m.attachment = null; }
    } else if (e.type === 'room_updated') {
      loadRooms();
    } else if (e.type === 'room_removed') {
      loadRooms(); if (S.room && S.room.id === d.id) { toast('你已被移出该群组', true); go(''); }
    }
  };
}
setInterval(() => {
  const n = S.joined.reduce((a, r) => a + (r.unread || 0), 0);
  document.title = (n ? '(' + n + ') ' : '') + S.brand;
}, 1000);

async function loadRooms() {
  try {
    const r = await api('GET', '/api/m/rooms');
    S.joined = r.joined; S.publicRooms = r.public;
    if (S.room) { const cur = S.joined.find(x => x.id === S.room.id) || S.publicRooms.find(x => x.id === S.room.id); if (cur) S.room = Object.assign({}, cur, { joined: !!S.joined.find(x => x.id === cur.id) }); }
  } catch (e) {}
}
async function reloadMsgs() { if (S.room) try { S.msgs = await api('GET', '/api/m/rooms/' + S.room.id + '/messages'); } catch (e) {} }
let readT = null;
function markRead() {
  if (!S.room || !S.room.joined) return;
  clearTimeout(readT);
  readT = setTimeout(() => api('POST', '/api/m/rooms/' + S.room.id + '/read').catch(() => {}), 400);
  const r = S.joined.find(x => x.id === S.room.id); if (r) r.unread = 0;
}

// ---------- routing ----------
function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q] = h.split('?');
  const [name, arg] = p.split('/');
  S.route = { name: name || 'home', arg: arg || '', query: new URLSearchParams(q || '') };
}
function go(p) { location.hash = '#/' + p; }
window.addEventListener('hashchange', parse);
parse();

async function boot() {
  if (S.route.name === 'login' && S.route.query.get('code')) {
    try {
      const r = await fetch('/api/m/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: S.route.query.get('code') }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.token = d.token; localStorage.setItem('kc_m_token', d.token);
      history.replaceState(null, '', location.pathname + '#/');
      parse();
    } catch (e) { toast(e.message, true); history.replaceState(null, '', location.pathname); parse(); }
  }
  if (!S.token) return;
  try {
    const r = await api('GET', '/api/m/me');
    S.me = r.member; S.brand = r.name || S.brand;
    await loadRooms(); connect();
    const back = sessionStorage.getItem('kc_after_login');
    if (back) { sessionStorage.removeItem('kc_after_login'); go(back); }
  } catch (e) {}
}

// ---------- components ----------
const Ava = {
  props: { name: null, seed: null, small: Boolean, color: null },
  template: `<div class="ava" :class="{s:small}" :style="{background:color||colorOf(seed||name)}">{{(String(name||'?').trim()[0]||'?').toUpperCase()}}</div>`,
  methods: { colorOf },
};

const Login = {
  template: `<div class="login"><div class="card">
    <div class="logo"><Icon n="chats" :s="32" :w="2"/></div>
    <h2>{{S.brand}}</h2><p style="color:var(--text2);margin:0 0 26px">使用网站账号登录，加入群聊</p>
    <form @submit.prevent="submit">
      <input class="inp" v-model="email" placeholder="邮箱" autocomplete="username" required>
      <input class="inp" type="password" v-model="password" placeholder="密码" autocomplete="current-password" required>
      <button class="btn" style="width:100%;margin-top:6px" :disabled="busy">{{busy?'登录中…':'登录'}}</button>
    </form>
    <div class="hint">也可以在官网登录后，点右下角客服窗口里的「社区群聊」一键进入。密码只用于向官网验证身份，不会被保存。</div>
  </div></div>`,
  data: () => ({ S, email: '', password: '', busy: false }),
  methods: {
    async submit() {
      this.busy = true;
      try {
        const d = await api('POST', '/api/m/login', { email: this.email, password: this.password });
        S.token = d.token; localStorage.setItem('kc_m_token', d.token); await boot();
      } catch (e) { toast(e.message, true); }
      this.busy = false;
    },
  },
};

const App = {
  components: { Login, Ava },
  template: `
  <div v-if="S.toast" class="toast" :class="{err:S.toast.err}">{{S.toast.msg}}</div>
  <Login v-if="!S.token" />
  <div v-else-if="S.me" class="shell" :class="{'in-room': !!S.room || S.route.name==='join'}">
    <aside class="side">
      <div class="side-h"><div class="t">{{S.brand}}</div>
        <button class="ib icon" @click="profile=true" title="我的资料"><Icon n="person" :s="22"/></button></div>
      <div class="list">
        <div class="sec" v-if="S.joined.length">我的群组</div>
        <div v-for="r in S.joined" :key="r.id" class="room" :class="{on:S.room&&S.room.id===r.id}" @click="go('room/'+r.id)">
          <Ava :name="r.name" :color="r.color" />
          <div class="b"><div class="n"><span>{{r.name}}</span><span class="lock" v-if="r.kind!=='public'"><Icon n="lock" :s="14" :w="2"/></span></div><div class="l">{{r.last_msg||r.description||'暂无消息'}}</div></div>
          <div class="r"><span>{{shortTime(r.last_at)}}</span><span class="badge" v-if="r.unread">{{r.unread>99?'99+':r.unread}}</span></div>
        </div>
        <div class="sec" v-if="S.publicRooms.length">发现公开群组</div>
        <div v-for="r in S.publicRooms" :key="'p'+r.id" class="room" :class="{on:S.room&&S.room.id===r.id}" @click="go('room/'+r.id)">
          <Ava :name="r.name" :color="r.color" />
          <div class="b"><div class="n"><span>{{r.name}}</span></div><div class="l">{{r.description||(r.member_count+' 位成员')}}</div></div>
          <button class="btn sm" @click.stop="join(r)">加入</button>
        </div>
        <div v-if="!S.joined.length && !S.publicRooms.length" class="empty">暂时还没有群组</div>
      </div>
    </aside>
    <main class="main" @dragover.prevent="onDrag" @dragleave="dragging=false" @drop.prevent="onDrop">
      <template v-if="S.route.name==='join'">
        <div class="chat-h"><button class="ib back" @click="go('')"><Icon n="back" :s="24" :w="2.2"/></button><div class="t"><b>群组邀请</b></div></div>
        <div class="empty" v-if="invite">
          <div style="display:flex;justify-content:center"><Ava :name="invite.name" :color="invite.color" /></div>
          <h3 style="margin:10px 0 4px">{{invite.name}}</h3><div>{{invite.description}}</div>
          <div style="margin:8px 0 16px">{{invite.member_count}} 位成员 · {{invite.kind==='public'?'公开群组':'私密群组'}}</div>
          <button class="btn" @click="acceptInvite">{{invite.joined?'进入群组':'加入群组'}}</button>
        </div>
        <div class="empty" v-else-if="inviteErr">{{inviteErr}}</div>
      </template>
      <template v-else-if="S.room">
        <div class="chat-h">
          <button class="ib back" @click="go('')"><Icon n="back" :s="24" :w="2.2"/></button>
          <Ava :name="S.room.name" :color="S.room.color" small />
          <div class="t"><b>{{S.room.name}} <span class="lock" v-if="S.room.kind!=='public'"><Icon n="lock" :s="14" :w="2"/></span></b><small>{{S.room.member_count}} 位成员{{S.wsOn?'':' · 连接中…'}}</small></div>
          <button class="ib icon" v-if="S.room.joined && (S.room.kind==='public'||S.room.member_invite)" @click="makeInvite" title="邀请好友"><Icon n="link" :s="21"/><span class="lbl">邀请</span></button>
          <button class="ib icon" @click="openMembers" title="群成员"><Icon n="people" :s="21"/><span class="lbl">成员</span></button>
          <button class="ib icon" v-if="S.room.joined" @click="leave" title="退出群组"><Icon n="logout" :s="21"/><span class="lbl">退群</span></button>
        </div>
        <div class="pin" v-if="S.room.pinned && !S.room.pinned.deleted" @click="jump(S.room.pinned.id)"><span class="bar"></span><b>置顶消息</b><span>{{S.room.pinned.body||'[文件]'}}</span></div>
        <div class="msgs" ref="msgs" @scroll="onScroll">
          <template v-for="(m,i) in S.msgs" :key="m.id">
            <div class="day" v-if="newDay(i)">{{dayLabel(m.created_at)}}</div>
            <div v-if="m.sender_kind==='system'" class="sys">{{m.body}}</div>
            <div v-else class="msg" :class="{me:mine(m), sel:selMsg===m.id}" :id="'m'+m.id">
              <template v-if="!mine(m)"><Ava v-if="!cont(i)" :name="m.sender_name" :seed="m.sender_kind+m.sender_id" small /><div v-else class="sp"></div></template>
              <div class="bub" :class="{media:isMedia(m) && (mine(m) || cont(i))}" @click="selMsg = selMsg===m.id ? 0 : m.id">
                <div class="who" v-if="!mine(m) && !cont(i)" :style="{color:colorOf(m.sender_kind+m.sender_id)}">{{m.sender_name}}
                  <span class="tag staff" v-if="m.sender_kind==='staff'">官方</span><span class="tag tg" v-if="m.sender_kind==='tg'">TG</span></div>
                <div class="quote" v-if="m.reply" @click="jump(m.reply.id)"><b>{{m.reply.sender_name}}</b>{{m.reply.body}}</div>
                <div v-if="m.deleted" class="tx del">消息已删除</div>
                <template v-else>
                  <img v-if="m.attachment && (m.attachment.type||'').startsWith('image/')" :src="m.attachment.url" loading="lazy" @click="viewer=m.attachment.url" @load="imgLoaded">
                  <a v-else-if="m.attachment" :href="m.attachment.url" target="_blank" rel="noopener" class="file"><Icon n="doc" :s="18"/>{{m.attachment.name||'文件'}}</a>
                  <div class="tx" v-if="m.body" v-html="rich(m.body)"></div>
                </template>
                <div class="tm">{{hm(m.created_at)}}</div>
              </div>
              <div class="acts" v-if="!m.deleted && S.room.joined"><button @click="reply=m;selMsg=0">回复</button><button v-if="mine(m)" @click="del(m);selMsg=0">删除</button></div>
            </div>
          </template>
          <div v-if="!S.msgs.length" class="empty">还没有消息，来说第一句话吧 👋</div>
        </div>
        <div class="joinbar" v-if="!S.room.joined"><button class="btn" @click="join(S.room)">加入群组</button></div>
        <div class="joinbar" v-else-if="S.room.readonly" ><Icon n="megaphone" :s="18"/>这是公告频道，仅官方可以发言</div>
        <div class="composer" v-else>
          <div class="replybar" v-if="reply"><div>回复 <b>{{reply.sender_name}}</b>：{{reply.body||'[文件]'}}</div><button class="ib icon" @click="reply=null"><Icon n="close" :s="16"/></button></div>
          <div class="emoji" v-if="emojiOpen">
            <div class="etabs"><a v-for="(g,i) in EMOJI" :key="g[0]" :class="{on:emojiTab===i}" @click="emojiTab=i">{{g[0]}}</a></div>
            <div class="egrid"><span v-for="e in EMOJI[emojiTab][1]" :key="e" @click="addEmoji(e)">{{e}}</span></div>
          </div>
          <div class="uploading" v-if="uploading">⏳ 正在发送 {{uploading}}…</div>
          <div class="row">
            <button class="ib icon" :class="{on:emojiOpen}" @click="emojiOpen=!emojiOpen" title="表情"><Icon n="smile" :s="24"/></button>
            <button class="ib icon" @click="$refs.img.click()" title="发图片"><Icon n="photo" :s="24"/></button>
            <button class="ib icon" @click="$refs.file.click()" title="发文件"><Icon n="clip" :s="22"/></button>
            <textarea ref="ta" v-model="text" rows="1" placeholder="发消息…" @keydown="keydown" @input="grow" @paste="paste" @click="narrow() && (emojiOpen=false)"></textarea>
            <button class="send" @click="send()" :disabled="!text.trim()"><Icon n="send" :s="20" :w="2.4"/></button>
            <input type="file" ref="img" accept="image/*" multiple style="display:none" @change="pick">
            <input type="file" ref="file" style="display:none" @change="pick">
          </div>
        </div>
      </template>
      <div v-else class="empty">选择一个群组开始聊天</div>
      <div class="drop" v-if="dragging">松开发送图片 / 文件</div>
    </main>
    <div class="viewer" v-if="viewer" @click="viewer=null"><img :src="viewer"><a :href="viewer" target="_blank" rel="noopener" @click.stop class="vdl">查看原图</a></div>
    <div class="mask" v-if="profile" @click.self="profile=false"><div class="modal">
      <h3>我的资料</h3>
      <div style="font-size:13px;color:var(--text2);margin-bottom:6px">群聊昵称（其他成员只能看到昵称，看不到你的邮箱）</div>
      <input class="inp" v-model="nick" maxlength="20">
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" @click="logout">退出登录</button><button class="btn" @click="saveNick">保存</button></div>
    </div></div>
    <div class="mask" v-if="members" @click.self="members=null"><div class="modal">
      <h3>群成员（{{members.length}}）</h3>
      <div class="mem" v-for="m in members" :key="m.id"><Ava :name="m.name" :seed="'member'+m.id" small /><span style="flex:1">{{m.name}}</span><span class="dot" v-if="m.online"></span></div>
    </div></div>
    <div class="mask" v-if="inviteLink" @click.self="inviteLink=null"><div class="modal">
      <h3>邀请好友</h3><div style="font-size:14px;color:var(--text2)">把链接发给好友，登录后即可加入（7 天内有效，最多 50 人）</div>
      <div class="code">{{inviteLink}}</div>
      <div style="text-align:right"><button class="btn" @click="copy(inviteLink)">复制链接</button></div>
    </div></div>
  </div>`,
  data: () => ({ S, EMOJI, selMsg: 0, emojiOpen: false, emojiTab: 0, uploading: '', viewer: null, dragging: false, text: '', reply: null, profile: false, nick: '', members: null, inviteLink: null, invite: null, inviteErr: '', loadingOld: false }),
  watch: {
    'S.route': { immediate: true, handler() { this.route(); } },
    'S.me'(m) { if (m) { this.nick = m.name; this.route(); } },
    'S.msgs.length'() { if (!this.loadingOld) this.bottom(); },
    profile(v) { if (v) this.nick = S.me.name; },
  },
  methods: {
    go, colorOf, rich, hm, dayLabel, shortTime,
    mine(m) { return m.sender_kind === 'member' && m.sender_id === S.me.id; },
    cont(i) { const a = S.msgs[i - 1], b = S.msgs[i]; return a && a.sender_kind === b.sender_kind && a.sender_id === b.sender_id && a.sender_kind !== 'system' && b.created_at - a.created_at < 300000 && !this.newDay(i); },
    newDay(i) { return i === 0 || new Date(S.msgs[i - 1].created_at).toDateString() !== new Date(S.msgs[i].created_at).toDateString(); },
    async route() {
      if (!S.me) return;
      const { name, arg } = S.route;
      if (name === 'room') {
        const id = parseInt(arg);
        let r = S.joined.find(x => x.id === id), joined = !!r;
        if (!r) r = S.publicRooms.find(x => x.id === id);
        if (!r) { await loadRooms(); r = S.joined.find(x => x.id === id); joined = !!r; if (!r) r = S.publicRooms.find(x => x.id === id); }
        if (!r) { S.room = null; return; }
        S.room = Object.assign({}, r, { joined }); this.reply = null; S.msgs = [];
        await reloadMsgs(); markRead(); this.bottom();
      } else if (name === 'join') {
        S.room = null; this.invite = null; this.inviteErr = '';
        try { this.invite = await api('GET', '/api/m/invites/' + arg); } catch (e) { this.inviteErr = e.message; }
      } else { S.room = null; }
    },
    bottom() { nextTick(() => { const el = this.$refs.msgs; if (el) el.scrollTop = el.scrollHeight; }); },
    async onScroll(e) {
      const el = e.target;
      if (el.scrollTop > 60 || this.loadingOld || S.msgs.length < 60) return;
      this.loadingOld = true;
      const h = el.scrollHeight;
      try {
        const old = await api('GET', '/api/m/rooms/' + S.room.id + '/messages?before=' + S.msgs[0].id);
        if (old.length) { S.msgs.unshift(...old); await nextTick(); el.scrollTop = el.scrollHeight - h; }
      } catch (x) {}
      setTimeout(() => { this.loadingOld = false; }, 300);
    },
    jump(id) { const el = document.getElementById('m' + id); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.style.opacity = .5; setTimeout(() => el.style.opacity = 1, 600); } },
    keydown(e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.innerWidth > 760) { e.preventDefault(); this.send(); } },
    grow(e) { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; },
    async send(att) {
      const body = this.text.trim();
      if (!body && !att) return;
      try {
        const m = await api('POST', '/api/m/rooms/' + S.room.id + '/messages', { body, attachment: att || null, reply_to: this.reply ? this.reply.id : 0 });
        if (!S.msgs.some(x => x.id === m.id)) S.msgs.push(m);
        if (!att) { this.text = ''; if (this.$refs.ta) this.$refs.ta.style.height = 'auto'; }
        this.reply = null;
      } catch (e) { toast(e.message, true); }
    },
    narrow() { return window.innerWidth <= 760; },
    isMedia(m) { return !m.deleted && !m.body && !m.reply && m.attachment && (m.attachment.type || '').startsWith('image/'); },
    addEmoji(e) { this.text = insertAt(this.$refs.ta, this.text, e, this.narrow()); },
    imgLoaded() { if (!this.loadingOld) { const el = this.$refs.msgs; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight; } },
    onDrag(e) { if (S.room && S.room.joined && [...(e.dataTransfer.types || [])].includes('Files')) this.dragging = true; },
    onDrop(e) { this.dragging = false; if (!S.room || !S.room.joined) return; [...(e.dataTransfer.files || [])].slice(0, 9).forEach(f => this.upload(f)); },
    async upload(f) {
      if (f.size > 20 * 1024 * 1024) return toast('文件不能超过 20MB', true);
      this.uploading = f.name; this.emojiOpen = false;
      try {
        const fd = new FormData(); fd.append('file', await compressImage(f));
        const a = await api('POST', '/api/m/upload', fd); const t = this.text; this.text = ''; await this.send(a); this.text = t;
      } catch (e) { toast(e.message, true); }
      this.uploading = '';
    },
    async pick(e) { const fs = [...e.target.files].slice(0, 9); e.target.value = ''; for (const f of fs) await this.upload(f); },
    paste(e) { const f = [...((e.clipboardData || {}).files || [])][0]; if (f) { e.preventDefault(); this.upload(f); } },
    async del(m) { if (!confirm('删除这条消息？')) return; try { await api('DELETE', '/api/m/messages/' + m.id); } catch (e) { toast(e.message, true); } },
    async join(r) {
      try { await api('POST', '/api/m/rooms/' + r.id + '/join'); await loadRooms(); go('room/' + r.id); if (S.room && S.room.id === r.id) this.route(); toast('已加入 ' + r.name); } catch (e) { toast(e.message, true); }
    },
    async leave() {
      if (!confirm('退出「' + S.room.name + '」？')) return;
      try { await api('POST', '/api/m/rooms/' + S.room.id + '/leave'); await loadRooms(); go(''); } catch (e) { toast(e.message, true); }
    },
    async acceptInvite() {
      try { const r = await api('POST', '/api/m/invites/' + S.route.arg); await loadRooms(); go('room/' + r.room_id); } catch (e) { toast(e.message, true); }
    },
    async makeInvite() { try { this.inviteLink = (await api('POST', '/api/m/rooms/' + S.room.id + '/invite')).url; } catch (e) { toast(e.message, true); } },
    async openMembers() { try { this.members = await api('GET', '/api/m/rooms/' + S.room.id + '/members'); } catch (e) { toast(e.message, true); } },
    copy(t) { navigator.clipboard.writeText(t).then(() => toast('已复制')); },
    open(u) { window.open(u, '_blank'); },
    async saveNick() { try { S.me = await api('PUT', '/api/m/me', { name: this.nick }); this.profile = false; toast('已保存'); } catch (e) { toast(e.message, true); } },
    async logout() { try { await api('POST', '/api/m/logout'); } catch (e) {} signOut(); this.profile = false; },
  },
};

// remember an invite link across the login screen
if (!S.token && S.route.name === 'join') sessionStorage.setItem('kc_after_login', 'join/' + S.route.arg);
createApp(App).component('Icon', Icon).mount('#app');
boot();
