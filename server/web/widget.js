/* Koyun Chat visitor widget. Embed:
 * <script src="https://CHAT_HOST/widget.js" data-site="SITE_KEY" async></script>
 * Optional identity for non-xboard sites: window.KoyunChat = { user: { email: "...", name: "..." } }
 */
(function () {
  if (window.__koyunChatLoaded) return;
  window.__koyunChatLoaded = true;

  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[data-site]');
    return s[s.length - 1];
  })();
  if (!script) return;
  var SITE = script.getAttribute('data-site');
  var BASE = new URL(script.src).origin;
  var WS_URL = BASE.replace(/^http/, 'ws') + '/ws/visitor?site=' + encodeURIComponent(SITE);
  var KEY = 'kc_' + SITE;

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  var store = load();

  var state = {
    ws: null, open: !!store.open, config: null, messages: [], unread: 0, agentsOnline: false,
    typing: null, retry: 0, visitor: {}, askContact: false, closedConv: false, connected: false, identity: null
  };

  // ---------- xboard identity (read-only, same-origin) ----------
  function xboardToken() {
    try {
      var raw = localStorage.getItem('VUE_NAIVE_ACCESS_TOKEN') || localStorage.getItem('Vue_Naive_access_token');
      if (!raw) return '';
      var v = JSON.parse(raw);
      if (v && typeof v === 'object') v = v.value;
      return typeof v === 'string' ? v : '';
    } catch (e) { return ''; }
  }
  function fetchJSON(url, token) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { ctl && ctl.abort(); }, 4000);
    return fetch(url, { headers: { Authorization: token }, credentials: 'same-origin', signal: ctl && ctl.signal })
      .then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
      .catch(function () { clearTimeout(t); return null; });
  }
  function gb(b) { return (Number(b || 0) / 1073741824).toFixed(2) + ' GB'; }
  function date(ts) { if (!ts) return '长期有效'; var d = new Date(ts * 1000); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  var lastToken = null;
  function loadIdentity() {
    if (window.KoyunChat && window.KoyunChat.user) return Promise.resolve(window.KoyunChat.user);
    var tok = xboardToken();
    lastToken = tok;
    if (!tok) return Promise.resolve(null);
    return Promise.all([fetchJSON('/api/v1/user/info', tok), fetchJSON('/api/v1/user/getSubscribe', tok)]).then(function (r) {
      var info = r[0] && r[0].data, sub = r[1] && r[1].data;
      if (!info && !sub) return null;
      var u = {};
      if (info) {
        u.email = info.email;
        u.balance = (Number(info.balance || 0) / 100).toFixed(2);
        u.commission_balance = (Number(info.commission_balance || 0) / 100).toFixed(2);
        u.expired_at = date(info.expired_at);
        if (info.banned) u.banned = '已封禁';
      }
      if (sub) {
        u.plan = sub.plan ? sub.plan.name : '无套餐';
        u.traffic_used = gb(Number(sub.u || 0) + Number(sub.d || 0));
        u.traffic_total = gb(sub.transfer_enable);
        if (sub.reset_day != null) u.traffic_reset_day = sub.reset_day + ' 天后';
        if (!u.expired_at) u.expired_at = date(sub.expired_at);
      }
      return u;
    });
  }

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.id = 'koyun-chat';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var css = '\
:host{all:initial}\
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.01em}\
.kc{position:fixed;bottom:22px;z-index:2147483000;--c:#0071e3}\
.kc.right{right:22px}.kc.left{left:22px}\
.btn{width:60px;height:60px;border-radius:50%;background:var(--c);background-image:linear-gradient(180deg,rgba(255,255,255,.22),rgba(0,0,0,.06));border:0;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.12);display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(.2,.9,.3,1.3);position:relative}\
.btn:hover{transform:scale(1.07)}\
.btn:active{transform:scale(.95)}\
.btn svg{width:28px;height:28px;fill:#fff}\
.badge{position:absolute;top:-3px;right:-3px;background:#ff3b30;color:#fff;font-size:12px;font-weight:600;min-width:22px;height:22px;border-radius:11px;display:flex;align-items:center;justify-content:center;padding:0 6px;border:2px solid #fff}\
.preview{position:absolute;bottom:76px;width:270px;background:rgba(255,255,255,.92);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);color:#1d1d1f;border-radius:18px;padding:12px 15px;box-shadow:0 12px 40px rgba(0,0,0,.16),0 0 0 .5px rgba(0,0,0,.06);font-size:14px;line-height:1.45;cursor:pointer;word-break:break-word;animation:pop .3s cubic-bezier(.2,.9,.3,1.2)}\
.right .preview{right:0}.left .preview{left:0}\
.preview b{display:block;font-size:12px;color:#6e6e73;margin-bottom:2px;font-weight:600}\
.panel{position:absolute;bottom:78px;width:380px;height:min(620px,calc(100vh - 116px));background:#fff;border-radius:24px;box-shadow:0 24px 70px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.08);display:flex;flex-direction:column;overflow:hidden;animation:pop .32s cubic-bezier(.2,.9,.3,1.15);transform-origin:bottom right}\
.right .panel{right:0}.left .panel{left:0;transform-origin:bottom left}\
@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}\
.hd{background:var(--c);background-image:linear-gradient(160deg,rgba(255,255,255,.18),rgba(0,0,0,.08));color:#fff;padding:18px 16px 16px 20px;display:flex;align-items:center;gap:12px}\
.hd .t{flex:1;min-width:0}.hd .t1{font-size:17px;font-weight:600;letter-spacing:-.02em}\
.hd .t2{font-size:12.5px;opacity:.92;margin-top:3px;display:flex;align-items:center;gap:6px}\
.dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.55);display:inline-block}.dot.on{background:#34c759;box-shadow:0 0 0 2px rgba(52,199,89,.3)}\
.x{background:rgba(255,255,255,.2);border:0;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}\
.x:hover{background:rgba(255,255,255,.32)}\
.x svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.4;stroke-linecap:round}\
.x.cm{width:auto;padding:0 12px;border-radius:15px;font-size:13px;font-weight:600}\
.body{flex:1;overflow-y:auto;padding:16px 14px;background:#fff;display:flex;flex-direction:column;gap:6px}\
.row{display:flex;flex-direction:column;max-width:80%}\
.row.me{align-self:flex-end;align-items:flex-end}\
.row.sys{align-self:center;max-width:90%}\
.who{font-size:11.5px;color:#8e8e93;margin:0 10px 3px;font-weight:500}\
.bub{padding:8px 13px;border-radius:19px;font-size:15px;line-height:1.42;white-space:pre-wrap;word-break:break-word;background:#e9e9eb;color:#1d1d1f}\
.me .bub{background:var(--c);color:#fff;border-bottom-right-radius:6px}\
.them .bub{border-bottom-left-radius:6px}\
.sys .bub{background:#f2f2f7;color:#8e8e93;font-size:12px;text-align:center;padding:3px 12px;border-radius:12px}\
.bub a{color:inherit;text-decoration:underline}\
.bub img{max-width:230px;max-height:240px;border-radius:14px;display:block;cursor:zoom-in;margin:-3px -8px}\
.file{display:flex;gap:8px;align-items:center;text-decoration:none!important}\
.time{font-size:10.5px;color:#a1a1a6;margin:3px 10px 0}\
.typing{font-size:12px;color:#8e8e93;padding:0 18px 6px;background:#fff;min-height:20px}\
.ft{border-top:1px solid rgba(60,60,67,.1);padding:8px 10px 10px;display:flex;gap:2px;align-items:flex-end;background:#fafafa}\
.ft textarea{flex:1;border:1px solid rgba(60,60,67,.16);outline:0;resize:none;font-size:15px;line-height:1.4;max-height:110px;min-height:36px;padding:7px 14px;background:#fff;color:#1d1d1f;border-radius:18px;margin:0 4px;transition:border-color .15s}\
.ft textarea:focus{border-color:var(--c)}\
.ib{border:0;background:transparent;cursor:pointer;width:34px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#8e8e93;flex-shrink:0;transition:background .15s,color .15s}\
.ib:hover{background:rgba(118,118,128,.1);color:#1d1d1f}\
.ib.on{color:var(--c)}\
.ib svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\
.ib.send{width:36px;height:36px;border-radius:50%;background:var(--c);color:#fff;margin-left:2px}\
.ib.send:hover{filter:brightness(1.08);background:var(--c);color:#fff}\
.ib.send svg{width:18px;height:18px;stroke-width:2.6}\
.emo{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px 10px;border-top:1px solid rgba(60,60,67,.1);background:#fafafa;max-height:160px;overflow-y:auto}\
.emo span{font-size:24px;line-height:38px;text-align:center;cursor:pointer;border-radius:10px;user-select:none;transition:transform .1s}\
.emo span:hover{background:rgba(118,118,128,.12);transform:scale(1.15)}\
.card{background:#f2f2f7;border-radius:16px;padding:14px;font-size:13.5px;color:#1d1d1f;align-self:stretch;line-height:1.5}\
.card input{width:100%;border:1px solid transparent;border-radius:10px;padding:9px 12px;margin-top:8px;font-size:14px;outline:0;background:#fff}\
.card input:focus{border-color:var(--c)}\
.card button{margin-top:10px;width:100%;border:0;border-radius:980px;padding:10px;background:var(--c);color:#fff;font-size:14px;font-weight:600;cursor:pointer}\
.stars{display:flex;gap:8px;justify-content:center;margin-top:8px}\
.stars span{font-size:28px;cursor:pointer;color:#d1d1d6;transition:transform .1s}.stars span:hover{transform:scale(1.15);color:#ff9500}\
.pw{font-size:10px;color:#c7c7cc;text-align:center;padding:0 0 6px;background:#fafafa}\
@media (max-width:480px){.kc.open{right:0!important;left:0!important;bottom:0}.kc.open .btn{display:none}.panel{position:fixed;inset:0;width:100%;height:100%;border-radius:0;bottom:0;animation:none}}\
';
  root.innerHTML = '<style>' + css + '</style><div class="kc right"></div>';
  var wrap = root.querySelector('.kc');

  var EMOJI = '😀 😂 🤣 😊 😍 🥰 😘 😎 🤔 😅 😭 😡 😱 😳 🥺 😴 🙄 😏 😇 🤗 🤝 👍 👎 👏 🙏 💪 👌 ✌️ 🙌 👋 🎉 ❤️ 💔 🔥 ✅ ❌ ❓ ❗ 💯 🌹 💰 🎁 ☕ 🍺 🚀 ⭐ 🌈 😉 😆 😢 😤 🤯 🥳 🤣 😋 🙈 💩 👀 🤞'.split(' ');
  var ICON_CHAT = '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1L4 21l4.2-2.1c1.2.4 2.5.6 3.8.6 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V5.5M6 11.5l6-6 6 6"/></svg>';
  var ICON_CLIP = '<svg viewBox="0 0 24 24"><path d="M20.5 11.3 12.2 19.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>';
  var ICON_SMILE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2a4.4 4.4 0 0 0 6.8 0M9.2 9.8h.01M14.8 9.8h.01" stroke-width="2.2"/></svg>';
  var ICON_PHOTO = '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.8" cy="9.7" r="1.7"/><path d="m21 15.5-4.6-4.6L7 20.3"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'); }
  function hm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function fileURL(u) { return BASE + u; }

  function renderMsg(m) {
    var mine = m.sender_type === 'visitor';
    var sys = m.sender_type === 'system';
    var cls = sys ? 'sys' : mine ? 'me' : 'them';
    var who = '';
    if (!mine && !sys) who = '<div class="who">' + esc(m.sender_name || (state.config && state.config.title) || '客服') + '</div>';
    var body = m.body ? linkify(m.body) : '';
    var a = m.attachment;
    if (a && a.url) {
      if (/^image\//.test(a.type || '')) body += (body ? '<br>' : '') + '<img src="' + esc(fileURL(a.url)) + '" data-full="' + esc(fileURL(a.url)) + '">';
      else body += (body ? '<br>' : '') + '<a class="file" href="' + esc(fileURL(a.url)) + '" target="_blank" rel="noopener">📎 ' + esc(a.name || '文件') + '</a>';
    }
    return '<div class="row ' + cls + '">' + who + '<div class="bub">' + body + '</div>' + (sys ? '' : '<div class="time">' + hm(m.created_at) + '</div>') + '</div>';
  }

  function render() {
    var c = state.config || {};
    wrap.style.setProperty('--c', c.color || '#2563eb');
    wrap.className = 'kc ' + (c.position === 'left' ? 'left' : 'right') + (state.open ? ' open' : '');
    var html = '';
    if (state.open) {
      var status = state.agentsOnline ? '<span class="dot on"></span>客服在线' : (c.ai ? '<span class="dot on"></span>' + esc(c.ai_name || 'AI 助手') + ' 在线' : '<span class="dot"></span>客服离线，可留言');
      html += '<div class="panel"><div class="hd"><div class="t"><div class="t1">' + esc(c.title || '在线客服') + '</div><div class="t2">' + status + '</div></div>' + (c.community ? '<button class="x cm" data-act="community" title="社区群聊">群聊</button>' : '') + '<button class="x" data-act="close" title="关闭">' + ICON_X + '</button></div>';
      html += '<div class="body">';
      if (c.welcome) html += renderMsg({ sender_type: 'agent', sender_name: c.title, body: c.welcome, created_at: Date.now() }).replace('<div class="time">' + hm(Date.now()) + '</div>', '');
      for (var i = 0; i < state.messages.length; i++) html += renderMsg(state.messages[i]);
      if (state.askContact && !(state.visitor.email)) {
        html += '<div class="card">留下联系方式，客服上线后会联系您：<input data-f="name" placeholder="称呼" value="' + esc(state.visitor.name || '') + '"><input data-f="email" placeholder="邮箱 / Telegram" value=""><button data-act="contact">提交</button></div>';
      }
      if (state.closedConv) {
        html += '<div class="card" style="text-align:center">本次服务满意吗？<div class="stars">' + [1, 2, 3, 4, 5].map(function (n) { return '<span data-rate="' + n + '">★</span>'; }).join('') + '</div></div>';
      }
      html += '</div><div class="typing">' + (state.typing ? esc(state.typing) + ' 正在输入…' : (!state.connected ? '连接中…' : '')) + '</div>';
      if (state.emoji) html += '<div class="emo">' + EMOJI.map(function (e) { return '<span data-emoji="' + e + '">' + e + '</span>'; }).join('') + '</div>';
      html += '<div class="ft"><button class="ib' + (state.emoji ? ' on' : '') + '" data-act="emoji" title="表情">' + ICON_SMILE + '</button><button class="ib" data-act="image" title="发图片">' + ICON_PHOTO + '</button><button class="ib" data-act="file" title="发送文件">' + ICON_CLIP + '</button><textarea rows="1" placeholder="输入消息，Enter 发送"></textarea><button class="ib send" data-act="send" title="发送">' + ICON_SEND + '</button></div>';
      html += '<div class="pw">Powered by Koyun Chat</div></div>';
    } else if (state.preview) {
      html += '<div class="preview" data-act="open"><b>' + esc(state.preview.name) + '</b>' + esc(state.preview.text) + '</div>';
    }
    html += '<button class="btn" data-act="toggle">' + (state.open ? ICON_CLOSE : ICON_CHAT) + (state.unread && !state.open ? '<span class="badge">' + state.unread + '</span>' : '') + '</button>';
    html += '<input type="file" class="anyf" style="display:none"><input type="file" class="imgf" accept="image/*" style="display:none">';
    var ta = wrap.querySelector('textarea');
    var draft = ta ? ta.value : (store.draft || '');
    var focused = ta && root.activeElement === ta;
    wrap.innerHTML = html;
    var nta = wrap.querySelector('textarea');
    if (nta) {
      nta.value = draft;
      autosize(nta);
      if (focused || state.focusNext) { nta.focus(); state.focusNext = false; }
    }
    var b = wrap.querySelector('.body');
    if (b) b.scrollTop = b.scrollHeight;
  }

  function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 110) + 'px'; }

  wrap.addEventListener('click', function (e) {
    var em = e.target.closest('[data-emoji]');
    if (em) {
      var ta = wrap.querySelector('textarea'); if (!ta) return;
      var a = ta.selectionStart || ta.value.length, b = ta.selectionEnd || ta.value.length, t = em.getAttribute('data-emoji');
      ta.value = ta.value.slice(0, a) + t + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + t.length;
      store.draft = ta.value; save(store);
      return;
    }
    var el = e.target.closest('[data-act],[data-rate],img[data-full]');
    if (!el) return;
    if (el.dataset.full) { window.open(el.dataset.full, '_blank'); return; }
    if (el.dataset.rate) {
      send('rate', { rating: +el.dataset.rate });
      state.closedConv = false;
      state.messages.push({ sender_type: 'system', body: '感谢您的评价！', created_at: Date.now() });
      render();
      return;
    }
    var act = el.dataset.act;
    if (act === 'toggle') setOpen(!state.open);
    else if (act === 'open') setOpen(true);
    else if (act === 'close') setOpen(false);
    else if (act === 'send') submit();
    else if (act === 'file') wrap.querySelector('input.anyf').click();
    else if (act === 'image') wrap.querySelector('input.imgf').click();
    else if (act === 'emoji') { state.emoji = !state.emoji; render(); }
    else if (act === 'community') openCommunity();
    else if (act === 'contact') {
      var n = wrap.querySelector('[data-f=name]').value.trim(), m = wrap.querySelector('[data-f=email]').value.trim();
      if (!m) return;
      send('profile', { name: n, email: m });
      state.visitor.name = n; state.visitor.email = m; state.askContact = false;
      state.messages.push({ sender_type: 'system', body: '已收到您的联系方式，我们会尽快回复', created_at: Date.now() });
      render();
    }
  });

  var typingTimer = null;
  wrap.addEventListener('input', function (e) {
    if (e.target.tagName !== 'TEXTAREA') return;
    autosize(e.target);
    store.draft = e.target.value; save(store);
    if (!typingTimer) {
      typingTimer = setTimeout(function () {
        typingTimer = null;
        var t = wrap.querySelector('textarea');
        send('typing', { text: t ? t.value : '' });
      }, 400);
    }
  });
  wrap.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'TEXTAREA' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  wrap.addEventListener('change', function (e) {
    if (e.target.type !== 'file' || !e.target.files[0]) return;
    var f = e.target.files[0];
    if (f.size > 20 * 1024 * 1024) { alert('文件最大 20MB'); return; }
    state.emoji = false;
    shrink(f, function (f) { uploadFile(f); });
    e.target.value = '';
  });
  function uploadFile(f) {
    var fd = new FormData(); fd.append('file', f);
    state.typing = null;
    state.messages.push({ sender_type: 'system', body: '正在上传 ' + f.name + '…', created_at: Date.now(), _tmp: 1 });
    render();
    fetch(BASE + '/api/widget/upload?vid=' + encodeURIComponent(store.vid) + '&vtoken=' + encodeURIComponent(store.vtoken), { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (a) {
        state.messages = state.messages.filter(function (m) { return !m._tmp; });
        if (a.error) { state.messages.push({ sender_type: 'system', body: a.error, created_at: Date.now() }); render(); return; }
        send('msg', { text: '', attachment: a });
      })
      .catch(function () { state.messages = state.messages.filter(function (m) { return !m._tmp; }); render(); });
  }
  // paste a screenshot straight into the chat
  wrap.addEventListener('paste', function (e) {
    var f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f) { e.preventDefault(); shrink(f, uploadFile); }
  });
  // shrink large phone photos before upload; GIFs and small images are sent as-is
  function shrink(f, cb) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size < 400 * 1024 || !window.URL) return cb(f);
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      URL.revokeObjectURL(url);
      var k = Math.min(1, 1600 / Math.max(img.width, img.height));
      var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (b) { cb(b && b.size < f.size ? new File([b], f.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : f); }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(f); };
    img.src = url;
  }

  // Open the community chat; when signed in to Xboard, exchange the session for a one-time login link.
  function openCommunity() {
    var c = state.config || {};
    var win = window.open('about:blank', '_blank');
    var tok = xboardToken();
    if (!tok || !c.xboard) { if (win) win.location = c.community_url; return; }
    fetch(BASE + '/api/m/sso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (win) win.location = d.url || c.community_url; })
      .catch(function () { if (win) win.location = c.community_url; });
  }

  function submit() {
    var t = wrap.querySelector('textarea');
    var text = t ? t.value.trim() : '';
    if (!text) return;
    if (!send('msg', { text: text })) { alert('连接中，请稍候再试'); return; }
    t.value = ''; store.draft = ''; save(store);
    send('typing', { text: '' });
    state.closedConv = false;
    state.emoji = false;
    state.focusNext = true;
    autosize(t);
  }

  function setOpen(v) {
    state.open = v; state.preview = null;
    if (v) state.unread = 0;
    store.open = v; save(store);
    state.focusNext = v;
    render();
  }

  // ---------- socket ----------
  function send(type, data) {
    if (!state.ws || state.ws.readyState !== 1) return false;
    state.ws.send(JSON.stringify({ type: type, data: data }));
    return true;
  }

  var ac = null;
  function beep() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      [[988, 0], [784, 0.18]].forEach(function (n) {
        var t = ac.currentTime + n[1], o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.52);
      });
    } catch (e) {}
  }

  function connect() {
    var ws = new WebSocket(WS_URL);
    state.ws = ws;
    ws.onopen = function () {
      state.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', data: {
        vid: store.vid || '', vtoken: store.vtoken || '', url: location.href, title: document.title,
        referrer: document.referrer, lang: navigator.language, user: state.identity
      } }));
    };
    ws.onmessage = function (ev) {
      var e; try { e = JSON.parse(ev.data); } catch (x) { return; }
      var d = e.data;
      switch (e.type) {
        case 'welcome':
          store.vid = d.vid; store.vtoken = d.vtoken; save(store);
          state.config = d.config; state.messages = d.messages || []; state.agentsOnline = d.agents_online;
          state.visitor = d.visitor || {}; state.connected = true;
          render();
          break;
        case 'message':
          if (state.messages.some(function (m) { return m.id === d.id; })) break;
          state.messages.push(d); state.typing = null;
          if (d.sender_type !== 'visitor' && d.sender_type !== 'system') {
            if (!state.open) { state.unread++; state.preview = { name: d.sender_name || '客服', text: d.body || '[文件]' }; }
            beep();
          }
          render();
          break;
        case 'agent_typing':
          state.typing = d.typing ? d.name : null; render();
          if (d.typing) setTimeout(function () { if (state.typing === d.name) { state.typing = null; render(); } }, 8000);
          break;
        case 'agents_online': state.agentsOnline = d; render(); break;
        case 'ask_contact': state.askContact = true; render(); break;
        case 'conversation_closed': state.closedConv = true; render(); break;
        case 'error': state.messages.push({ sender_type: 'system', body: d, created_at: Date.now() }); render(); break;
      }
    };
    ws.onclose = function () {
      state.connected = false;
      if (state.open) render();
      var delay = Math.min(30000, 1000 * Math.pow(2, state.retry++)) + Math.random() * 1000;
      setTimeout(connect, delay);
    };
  }

  // ---------- page tracking (works for SPA hash/history routing) ----------
  var lastURL = location.href;
  function pageChanged() {
    setTimeout(function () {
      if (location.href === lastURL) return;
      lastURL = location.href;
      send('page', { url: location.href, title: document.title });
      var tok = xboardToken();
      if (tok !== lastToken) loadIdentity().then(function (u) { state.identity = u; if (u) send('identify', u); });
    }, 300);
  }
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); pageChanged(); return r; };
  });
  window.addEventListener('popstate', pageChanged);
  window.addEventListener('hashchange', pageChanged);

  window.KoyunChat = window.KoyunChat || {};
  window.KoyunChat.open = function () { setOpen(true); };
  window.KoyunChat.close = function () { setOpen(false); };

  function start() {
    document.body.appendChild(host);
    render();
    loadIdentity().then(function (u) { state.identity = u; connect(); });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
