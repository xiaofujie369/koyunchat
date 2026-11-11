<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NBadge, NButton, NEmpty, NInput, NModal, useMessage } from 'naive-ui'
import { ArrowLeft, Lock, UserRound } from '@lucide/vue'
import Ava from './Ava.vue'
import Login from './Login.vue'
import Room from './Room.vue'
import { S, api, connect, errMsg, loadRooms, markRead, onRoomRemoved, reloadMsgs, setToken, signOut } from '@/lib/store'
import { shortTime, type Row } from '@/lib/utils'

const route = useRoute(), router = useRouter(), msg = useMessage()
const go = (p: string) => router.push('/' + p)
const ready = ref(false)
const profile = ref(false), nick = ref('')
const invite = ref<Row | null>(null), inviteErr = ref('')
onRoomRemoved(t => { msg.error(t); go('') })

// 一次性登录码换令牌，然后加载资料和群组
async function boot() {
  const code = route.path === '/login' ? String(route.query.code || '') : ''
  if (code) {
    try {
      const r = await fetch('/api/m/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setToken(d.token)
    } catch (e) { msg.error(errMsg(e)) }
    await router.replace('/')
  }
  if (!S.token) {
    // 登录页上记住邀请链接，登录后跳回去
    if (route.path.startsWith('/join/')) sessionStorage.setItem('kc_after_login', route.path.slice(1))
    ready.value = true; return
  }
  try {
    const r = await api('GET', '/api/m/me')
    S.me = r.member; S.brand = r.name || S.brand
    await loadRooms(); connect()
    const back = sessionStorage.getItem('kc_after_login')
    if (back) { sessionStorage.removeItem('kc_after_login'); await router.replace('/' + back) }
  } catch { /* 令牌失效会自动退出 */ }
  ready.value = true
  onRoute()
}
onMounted(boot)

async function onRoute() {
  if (!S.me) return
  const p = route.path
  if (p.startsWith('/room/')) {
    const id = parseInt(String(route.params.id))
    let r = S.joined.find(x => x.id === id), joined = !!r
    if (!r) r = S.publicRooms.find(x => x.id === id)
    if (!r) { await loadRooms(); r = S.joined.find(x => x.id === id); joined = !!r; if (!r) r = S.publicRooms.find(x => x.id === id) }
    if (!r) { S.room = null; return }
    S.room = { ...r, joined }; S.msgs = []
    await reloadMsgs(); markRead()
  } else if (p.startsWith('/join/')) {
    S.room = null; invite.value = null; inviteErr.value = ''
    try { invite.value = await api('GET', '/api/m/invites/' + route.params.code) } catch (e) { inviteErr.value = errMsg(e) }
  } else S.room = null
}
watch(() => route.fullPath, onRoute)

async function join(r: Row) {
  try { await api('POST', '/api/m/rooms/' + r.id + '/join'); await loadRooms(); await go('room/' + r.id); onRoute(); msg.success('已加入 ' + r.name) } catch (e) { msg.error(errMsg(e)) }
}
async function acceptInvite() {
  try { const r = await api('POST', '/api/m/invites/' + route.params.code); await loadRooms(); go('room/' + r.room_id) } catch (e) { msg.error(errMsg(e)) }
}
function openProfile() { nick.value = S.me?.name || ''; profile.value = true }
async function saveNick() { try { S.me = await api('PUT', '/api/m/me', { name: nick.value }); profile.value = false; msg.success('已保存') } catch (e) { msg.error(errMsg(e)) } }
async function logout() { try { await api('POST', '/api/m/logout') } catch { /* 忽略 */ } signOut(); profile.value = false }
async function afterLogin() { ready.value = false; await boot() }
</script>

<template>
  <template v-if="ready">
    <Login v-if="!S.token || !S.me" @done="afterLogin" />
    <div v-else class="shell" :class="{ 'in-room': !!S.room || route.path.startsWith('/join/') }">
      <aside class="side">
        <div class="side-h"><div class="t">{{ S.brand }}</div>
          <button class="ib" title="我的资料" @click="openProfile"><UserRound :size="22" /></button></div>
        <div class="list">
          <div v-if="S.joined.length" class="sec">我的群组</div>
          <div v-for="r in S.joined" :key="r.id" class="room" :class="{ on: S.room?.id === r.id }" @click="go('room/' + r.id)">
            <Ava :name="r.name" :color="r.color" />
            <div class="b"><div class="n"><span>{{ r.name }}</span><Lock v-if="r.kind !== 'public'" :size="13" class="lock" /></div><div class="l">{{ r.last_msg || r.description || '暂无消息' }}</div></div>
            <div class="r"><span>{{ shortTime(r.last_at) }}</span><NBadge v-if="r.unread" :value="r.unread" :max="99" /></div>
          </div>
          <div v-if="S.publicRooms.length" class="sec">发现公开群组</div>
          <div v-for="r in S.publicRooms" :key="'p' + r.id" class="room" :class="{ on: S.room?.id === r.id }" @click="go('room/' + r.id)">
            <Ava :name="r.name" :color="r.color" />
            <div class="b"><div class="n"><span>{{ r.name }}</span></div><div class="l">{{ r.description || r.member_count + ' 位成员' }}</div></div>
            <NButton size="small" type="primary" secondary @click.stop="join(r)">加入</NButton>
          </div>
          <NEmpty v-if="!S.joined.length && !S.publicRooms.length" description="暂时还没有群组" style="margin-top: 60px" />
        </div>
      </aside>
      <main class="main">
        <template v-if="route.path.startsWith('/join/')">
          <div class="bar"><button class="ib back" @click="go('')"><ArrowLeft :size="22" /></button><b>群组邀请</b></div>
          <div class="center">
            <template v-if="invite">
              <Ava :name="invite.name" :color="invite.color" />
              <h3>{{ invite.name }}</h3><p>{{ invite.description }}</p>
              <p class="faint">{{ invite.member_count }} 位成员 · {{ invite.kind === 'public' ? '公开群组' : '私密群组' }}</p>
              <NButton type="primary" @click="acceptInvite">{{ invite.joined ? '进入群组' : '加入群组' }}</NButton>
            </template>
            <NEmpty v-else-if="inviteErr" :description="inviteErr" />
          </div>
        </template>
        <Room v-else-if="S.room" :key="S.room.id" @join="join" />
        <div v-else class="center faint">选择一个群组开始聊天</div>
      </main>
    </div>
    <NModal v-model:show="profile" preset="card" title="我的资料" style="width: 400px; max-width: 92vw">
      <div class="faint" style="font-size: 13px; margin-bottom: 8px">群聊昵称（其他成员只能看到昵称，看不到你的邮箱）</div>
      <NInput v-model:value="nick" :maxlength="20" />
      <template #footer><div style="display: flex; gap: 8px; justify-content: flex-end"><NButton @click="logout">退出登录</NButton><NButton type="primary" @click="saveNick">保存</NButton></div></template>
    </NModal>
  </template>
</template>

<style scoped>
.shell { display: flex; height: 100%; height: 100dvh; overflow: hidden; }
.side { width: 340px; flex-shrink: 0; background: var(--card); border-right: 1px solid var(--line); display: flex; flex-direction: column; }
.side-h { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.side-h .t { flex: 1; font-size: 19px; font-weight: 700; }
.list { flex: 1; overflow-y: auto; padding: 6px; }
.sec { font-size: 12px; color: var(--faint); padding: 12px 10px 6px; font-weight: 600; }
.room { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 12px; cursor: pointer; }
.room:hover { background: var(--bg); }
.room.on { background: var(--accent-soft); }
.room .b { flex: 1; min-width: 0; }
.room .n { display: flex; align-items: center; gap: 4px; font-weight: 600; }
.room .n span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room .l { font-size: 13.5px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room .r { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--faint); }
.lock { color: var(--faint); flex-shrink: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); position: relative; }
.bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--card); border-bottom: 1px solid var(--line); }
.center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; gap: 4px; }
.center h3 { margin: 10px 0 0; }
.center p { margin: 0 0 8px; }
.faint { color: var(--faint); }
.ib { border: 0; background: none; color: var(--sub); cursor: pointer; padding: 6px; border-radius: 8px; display: grid; place-items: center; }
.ib:hover { background: var(--bg); color: var(--ink); }
.back { display: none; }
@media (max-width: 760px) {
  .side { width: 100%; border-right: 0; }
  .main { display: none; }
  .shell.in-room .side { display: none; }
  .shell.in-room .main { display: flex; }
  .back { display: grid; }
}
</style>
