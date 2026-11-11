<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NModal, useDialog, useMessage } from 'naive-ui'
import { ArrowLeft, FileText, ImageIcon, Link2, LogOut, Megaphone, Paperclip, SendHorizontal, Smile, Users, X } from '@lucide/vue'
import Ava from './Ava.vue'
import { S, api, errMsg, loadRooms } from '@/lib/store'
import { EMOJI } from '@/lib/emoji'
import { colorOf, compressImage, dayLabel, hm, rich, type Row } from '@/lib/utils'

const emit = defineEmits<{ join: [room: Row] }>()
const router = useRouter(), msg = useMessage(), dialog = useDialog()
const room = () => S.room!
const box = ref<HTMLDivElement>(), ta = ref<HTMLTextAreaElement>(), imgIn = ref<HTMLInputElement>(), fileIn = ref<HTMLInputElement>()
const text = ref(''), reply = ref<Row | null>(null), sel = ref(0)
const emojiOpen = ref(false), emojiTab = ref(0), uploading = ref(''), dragging = ref(false), viewer = ref('')
const members = ref<Row[] | null>(null), inviteLink = ref('')
let loadingOld = false

const narrow = () => window.innerWidth <= 760
const mine = (m: Row) => m.sender_kind === 'member' && m.sender_id === S.me?.id
const newDay = (i: number) => i === 0 || new Date(S.msgs[i - 1].created_at).toDateString() !== new Date(S.msgs[i].created_at).toDateString()
const cont = (i: number) => { const a = S.msgs[i - 1], b = S.msgs[i]; return !!a && a.sender_kind === b.sender_kind && a.sender_id === b.sender_id && a.sender_kind !== 'system' && b.created_at - a.created_at < 300000 && !newDay(i) }
const isImg = (m: Row) => m.attachment && (m.attachment.type || '').startsWith('image/')
const media = (m: Row) => !m.deleted && !m.body && !m.reply && isImg(m)

function bottom() { nextTick(() => { const el = box.value; if (el) el.scrollTop = el.scrollHeight }) }
onMounted(bottom)
watch(() => S.msgs.length, () => { if (!loadingOld) bottom() })
function imgLoaded() { const el = box.value; if (!loadingOld && el && el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight }
async function onScroll() {
  const el = box.value!
  if (el.scrollTop > 60 || loadingOld || S.msgs.length < 60) return
  loadingOld = true; const h = el.scrollHeight
  try { const old: Row[] = await api('GET', '/api/m/rooms/' + room().id + '/messages?before=' + S.msgs[0].id); if (old.length) { S.msgs.unshift(...old); await nextTick(); el.scrollTop = el.scrollHeight - h } } catch { /* 忽略 */ }
  setTimeout(() => { loadingOld = false }, 300)
}
function jump(id: number) {
  const el = document.getElementById('m' + id)
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.style.opacity = '.5'; setTimeout(() => (el.style.opacity = '1'), 600) }
}

function grow() { const t = ta.value; if (t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px' } }
function keydown(e: KeyboardEvent) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !narrow()) { e.preventDefault(); send() } }
function addEmoji(e: string) {
  const t = ta.value, v = text.value
  if (!t) { text.value += e; return }
  const s = t.selectionStart ?? v.length, en = t.selectionEnd ?? v.length
  text.value = v.slice(0, s) + e + v.slice(en)
  requestAnimationFrame(() => { if (!narrow()) t.focus(); t.selectionStart = t.selectionEnd = s + e.length })
}
async function send(att?: Row) {
  const body = att ? '' : text.value.trim()
  if (!body && !att) return
  try {
    const m = await api('POST', '/api/m/rooms/' + room().id + '/messages', { body, attachment: att || null, reply_to: reply.value ? reply.value.id : 0 })
    if (!S.msgs.some(x => x.id === m.id)) S.msgs.push(m)
    if (!att) { text.value = ''; nextTick(grow) }
    reply.value = null
  } catch (e) { msg.error(errMsg(e)) }
}
async function upload(f: File) {
  if (f.size > 20 * 1024 * 1024) return msg.error('文件不能超过 20MB')
  uploading.value = f.name; emojiOpen.value = false
  try { const fd = new FormData(); fd.append('file', await compressImage(f)); await send(await api('POST', '/api/m/upload', fd)) } catch (e) { msg.error(errMsg(e)) }
  uploading.value = ''
}
async function pick(e: Event) { const inp = e.target as HTMLInputElement; const fs = [...(inp.files || [])].slice(0, 9); inp.value = ''; for (const f of fs) await upload(f) }
function paste(e: ClipboardEvent) { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); upload(f) } }
function onDrag(e: DragEvent) { if (room().joined && [...(e.dataTransfer?.types || [])].includes('Files')) dragging.value = true }
function onDrop(e: DragEvent) { dragging.value = false; if (room().joined) [...(e.dataTransfer?.files || [])].slice(0, 9).forEach(upload) }

function del(m: Row) {
  dialog.warning({ title: '删除消息', content: '删除这条消息？', positiveText: '删除', negativeText: '取消',
    onPositiveClick: async () => { try { await api('DELETE', '/api/m/messages/' + m.id) } catch (e) { msg.error(errMsg(e)) } } })
}
function leave() {
  dialog.warning({ title: '退出群组', content: '退出「' + room().name + '」？', positiveText: '退出', negativeText: '取消',
    onPositiveClick: async () => { try { await api('POST', '/api/m/rooms/' + room().id + '/leave'); await loadRooms(); router.push('/') } catch (e) { msg.error(errMsg(e)) } } })
}
async function makeInvite() { try { inviteLink.value = (await api('POST', '/api/m/rooms/' + room().id + '/invite')).url } catch (e) { msg.error(errMsg(e)) } }
async function openMembers() { try { members.value = await api('GET', '/api/m/rooms/' + room().id + '/members') } catch (e) { msg.error(errMsg(e)) } }
function copy(t: string) { navigator.clipboard.writeText(t).then(() => msg.success('已复制')) }
</script>

<template>
  <div class="chat" @dragover.prevent="onDrag" @dragleave="dragging = false" @drop.prevent="onDrop">
    <div class="chat-h">
      <button class="ib back" @click="router.push('/')"><ArrowLeft :size="22" /></button>
      <Ava :name="room().name" :color="room().color" small />
      <div class="t"><b>{{ room().name }}</b><small>{{ room().member_count }} 位成员{{ S.wsOn ? '' : ' · 连接中…' }}</small></div>
      <button v-if="room().joined && (room().kind === 'public' || room().member_invite)" class="ib" title="邀请好友" @click="makeInvite"><Link2 :size="20" /><span class="lbl">邀请</span></button>
      <button class="ib" title="群成员" @click="openMembers"><Users :size="20" /><span class="lbl">成员</span></button>
      <button v-if="room().joined" class="ib" title="退出群组" @click="leave"><LogOut :size="20" /><span class="lbl">退群</span></button>
    </div>
    <div v-if="room().pinned && !room().pinned.deleted" class="pin" @click="jump(room().pinned.id)"><span class="pbar" /><b>置顶消息</b><span class="ptx">{{ room().pinned.body || '[文件]' }}</span></div>

    <div ref="box" class="msgs" @scroll="onScroll">
      <template v-for="(m, i) in S.msgs" :key="m.id">
        <div v-if="newDay(i)" class="day">{{ dayLabel(m.created_at) }}</div>
        <div v-if="m.sender_kind === 'system'" class="sys">{{ m.body }}</div>
        <div v-else :id="'m' + m.id" class="msg" :class="{ me: mine(m), sel: sel === m.id }">
          <template v-if="!mine(m)"><Ava v-if="!cont(i)" :name="m.sender_name" :seed="m.sender_kind + m.sender_id" small /><div v-else class="sp" /></template>
          <div class="bub" :class="{ media: media(m) }" @click="sel = sel === m.id ? 0 : m.id">
            <div v-if="!mine(m) && !cont(i)" class="who" :style="{ color: colorOf(m.sender_kind + m.sender_id) }">{{ m.sender_name }}
              <span v-if="m.sender_kind === 'staff'" class="tag staff">官方</span><span v-if="m.sender_kind === 'tg'" class="tag tg">TG</span></div>
            <div v-if="m.reply" class="quote" @click.stop="jump(m.reply.id)"><b>{{ m.reply.sender_name }}</b>{{ m.reply.body }}</div>
            <div v-if="m.deleted" class="tx del">消息已删除</div>
            <template v-else>
              <img v-if="isImg(m)" :src="m.attachment.url" loading="lazy" @click.stop="viewer = m.attachment.url" @load="imgLoaded">
              <a v-else-if="m.attachment" :href="m.attachment.url" target="_blank" rel="noopener" class="file" @click.stop><FileText :size="18" />{{ m.attachment.name || '文件' }}</a>
              <!-- rich() 先转义 HTML，再加链接，安全 -->
              <div v-if="m.body" class="tx" v-html="rich(m.body)" />
            </template>
            <div class="tm">{{ hm(m.created_at) }}</div>
          </div>
          <div v-if="!m.deleted && room().joined" class="acts"><button @click="reply = m; sel = 0">回复</button><button v-if="mine(m)" @click="del(m); sel = 0">删除</button></div>
        </div>
      </template>
      <div v-if="!S.msgs.length" class="empty">还没有消息，来说第一句话吧 👋</div>
    </div>

    <div v-if="!room().joined" class="joinbar"><NButton type="primary" @click="emit('join', room())">加入群组</NButton></div>
    <div v-else-if="room().readonly" class="joinbar"><Megaphone :size="18" />这是公告频道，仅官方可以发言</div>
    <div v-else class="composer">
      <div v-if="reply" class="replybar"><div>回复 <b>{{ reply.sender_name }}</b>：{{ reply.body || '[文件]' }}</div><button class="ib" @click="reply = null"><X :size="16" /></button></div>
      <div v-if="emojiOpen" class="emoji">
        <div class="etabs"><a v-for="(g, i) in EMOJI" :key="g[0]" :class="{ on: emojiTab === i }" @click="emojiTab = i">{{ g[0] }}</a></div>
        <div class="egrid"><span v-for="e in EMOJI[emojiTab][1]" :key="e" @click="addEmoji(e)">{{ e }}</span></div>
      </div>
      <div v-if="uploading" class="uploading">⏳ 正在发送 {{ uploading }}…</div>
      <div class="row">
        <button class="ib" :class="{ on: emojiOpen }" title="表情" @click="emojiOpen = !emojiOpen"><Smile :size="23" /></button>
        <button class="ib" title="发图片" @click="imgIn?.click()"><ImageIcon :size="23" /></button>
        <button class="ib" title="发文件" @click="fileIn?.click()"><Paperclip :size="21" /></button>
        <textarea ref="ta" v-model="text" rows="1" placeholder="发消息…" @keydown="keydown" @input="grow" @paste="paste" @click="narrow() && (emojiOpen = false)" />
        <button class="send" :disabled="!text.trim()" @click="send()"><SendHorizontal :size="19" /></button>
        <input ref="imgIn" type="file" accept="image/*" multiple hidden @change="pick">
        <input ref="fileIn" type="file" hidden @change="pick">
      </div>
    </div>
    <div v-if="dragging" class="drop">松开发送图片 / 文件</div>
    <div v-if="viewer" class="viewer" @click="viewer = ''"><img :src="viewer"><a :href="viewer" target="_blank" rel="noopener" class="vdl" @click.stop>查看原图</a></div>

    <NModal :show="!!members" preset="card" :title="'群成员（' + (members?.length || 0) + '）'" style="width: 400px; max-width: 92vw" @update:show="v => !v && (members = null)">
      <div class="mems"><div v-for="m in members || []" :key="m.id" class="mem"><Ava :name="m.name" :seed="'member' + m.id" small /><span style="flex: 1">{{ m.name }}</span><span v-if="m.online" class="dot" /></div></div>
    </NModal>
    <NModal :show="!!inviteLink" preset="card" title="邀请好友" style="width: 440px; max-width: 92vw" @update:show="v => !v && (inviteLink = '')">
      <div class="faint">把链接发给好友，登录后即可加入（7 天内有效，最多 50 人）</div>
      <div class="code">{{ inviteLink }}</div>
      <template #footer><div style="text-align: right"><NButton type="primary" @click="copy(inviteLink)">复制链接</NButton></div></template>
    </NModal>
  </div>
</template>

<style scoped>
/* 外层不能叫 .room：Shell 里群组列表项也叫 .room，父组件样式会作用到子组件根元素 */
.chat { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; width: 100%; position: relative; }
.chat-h { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--card); border-bottom: 1px solid var(--line); }
.chat-h .t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.chat-h .t b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-h small { color: var(--faint); font-size: 12px; }
.ib { border: 0; background: none; color: var(--sub); cursor: pointer; padding: 6px 8px; border-radius: 8px; display: inline-flex; align-items: center; gap: 4px; }
.ib:hover, .ib.on { background: var(--bg); color: var(--accent); }
.lbl { font-size: 13px; }
.back { display: none; }
.pin { display: flex; align-items: center; gap: 8px; padding: 6px 14px; background: var(--card); border-bottom: 1px solid var(--line); cursor: pointer; font-size: 13px; }
.pbar { width: 3px; height: 18px; border-radius: 2px; background: var(--accent); }
.pin b { color: var(--accent); white-space: nowrap; }
.ptx { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sub); }
.msgs { flex: 1; overflow-y: auto; padding: 12px 14px 18px; }
.day { text-align: center; margin: 14px 0 8px; font-size: 12px; color: var(--faint); }
.sys { text-align: center; font-size: 12px; color: var(--faint); margin: 8px 0; }
.msg { display: flex; align-items: flex-end; gap: 8px; margin-top: 4px; transition: opacity .3s; position: relative; }
.msg.me { flex-direction: row-reverse; }
.sp { width: 34px; flex-shrink: 0; }
.bub { max-width: min(560px, 76%); background: var(--other); border: 1px solid var(--line); border-radius: 16px 16px 16px 4px; padding: 7px 11px 5px; position: relative; word-break: break-word; }
.me .bub { background: var(--mine); color: #fff; border-color: transparent; border-radius: 16px 16px 4px 16px; }
.bub.media { padding: 3px; background: transparent; border: 0; }
.bub img { display: block; max-width: 100%; max-height: 320px; border-radius: 12px; cursor: zoom-in; }
.who { font-size: 13px; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 4px; }
.tag { font-size: 11px; padding: 0 6px; border-radius: 6px; font-weight: 500; }
.tag.staff { background: #fbf2df; color: #c98a1c; }
.tag.tg { background: #229ed9; color: #fff; }
.quote { border-left: 3px solid var(--accent); padding: 2px 8px; margin: 2px 0 4px; font-size: 13px; background: rgba(0, 0, 0, .04); border-radius: 6px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me .quote { border-color: rgba(255, 255, 255, .7); background: rgba(255, 255, 255, .15); }
.quote b { margin-right: 6px; }
.tx { white-space: pre-wrap; }
.tx :deep(a) { color: inherit; text-decoration: underline; }
.del { font-style: italic; opacity: .6; }
.file { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; padding: 4px 0; }
.tm { font-size: 11px; opacity: .55; text-align: right; margin-top: 1px; }
.bub.media .tm { position: absolute; right: 10px; bottom: 8px; background: rgba(0, 0, 0, .45); color: #fff; padding: 0 6px; border-radius: 8px; opacity: 1; }
.acts { display: none; gap: 2px; align-self: center; }
.acts button { border: 0; background: var(--card); color: var(--sub); font-size: 12px; padding: 3px 8px; border-radius: 8px; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, .08); }
.msg:hover .acts, .msg.sel .acts { display: flex; }
.empty { text-align: center; color: var(--faint); padding: 60px 0; }
.joinbar { display: flex; justify-content: center; align-items: center; gap: 8px; padding: 14px; background: var(--card); border-top: 1px solid var(--line); color: var(--sub); font-size: 14px; }
.composer { background: var(--card); border-top: 1px solid var(--line); padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); }
.replybar { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--sub); padding: 4px 6px 8px; border-left: 3px solid var(--accent); margin-bottom: 6px; }
.replybar div { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.emoji { border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.etabs { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; }
.etabs a { font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; color: var(--sub); }
.etabs a.on { background: var(--accent-soft); color: var(--accent); }
.egrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); max-height: 200px; overflow-y: auto; }
.egrid span { font-size: 24px; text-align: center; padding: 3px; cursor: pointer; border-radius: 8px; }
.egrid span:hover { background: var(--bg); }
.uploading { font-size: 13px; color: var(--sub); padding: 2px 6px 6px; }
.row { display: flex; align-items: flex-end; gap: 2px; }
.row textarea { flex: 1; min-width: 0; width: 0; resize: none; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 20px; padding: 8px 14px; font: inherit; outline: none; max-height: 140px; margin: 0 4px; }
.row textarea:focus { border-color: var(--accent); }
.send { width: 38px; height: 38px; border-radius: 50%; border: 0; background: var(--accent); color: #fff; display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }
.send:disabled { opacity: .4; cursor: default; }
.drop { position: absolute; inset: 0; background: rgba(124, 107, 214, .12); border: 3px dashed var(--accent); display: grid; place-items: center; font-size: 18px; color: var(--accent); font-weight: 600; z-index: 5; }
.viewer { position: fixed; inset: 0; background: rgba(0, 0, 0, .85); display: grid; place-items: center; z-index: 100; cursor: zoom-out; }
.viewer img { max-width: 94vw; max-height: 88vh; border-radius: 6px; }
.vdl { position: absolute; bottom: 24px; color: #fff; font-size: 14px; }
.mems { max-height: 60vh; overflow-y: auto; }
.mem { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-top: 10px; word-break: break-all; }
.faint { color: var(--faint); font-size: 13px; }
@media (max-width: 760px) {
  .back { display: inline-flex; }
  .lbl { display: none; }
  .bub { max-width: 82%; }
}
</style>
