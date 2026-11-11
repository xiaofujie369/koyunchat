<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { MessagesSquare } from '@lucide/vue'
import { S, api, errMsg, setToken } from '@/lib/store'

const emit = defineEmits<{ done: [] }>()
const msg = useMessage()
const email = ref(''), password = ref(''), busy = ref(false)
async function submit() {
  if (!email.value || !password.value) return msg.error('请填写邮箱和密码')
  busy.value = true
  try { const d = await api('POST', '/api/m/login', { email: email.value, password: password.value }); setToken(d.token); emit('done') }
  catch (e) { msg.error(errMsg(e)) }
  busy.value = false
}
</script>
<template>
  <div class="login">
    <form class="card" @submit.prevent="submit">
      <div class="logo"><MessagesSquare :size="28" /></div>
      <h2>{{ S.brand }}</h2>
      <p class="sub">使用网站账号登录，加入群聊</p>
      <NInput v-model:value="email" placeholder="邮箱" size="large" :input-props="{ autocomplete: 'username', type: 'email' }" />
      <NInput v-model:value="password" type="password" placeholder="密码" size="large" show-password-on="click" :input-props="{ autocomplete: 'current-password' }" style="margin-top: 12px" />
      <NButton attr-type="submit" type="primary" size="large" block :loading="busy" style="margin-top: 18px">登录</NButton>
      <p class="hint">也可以在官网登录后，点右下角客服窗口里的「社区群聊」一键进入。密码只用于向官网验证身份，不会被保存。</p>
    </form>
  </div>
</template>
<style scoped>
.login { min-height: 100%; display: grid; place-items: center; padding: 20px; }
.card { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 32px 28px; }
.logo { width: 52px; height: 52px; border-radius: 14px; background: var(--accent); color: #fff; display: grid; place-items: center; margin-bottom: 16px; }
h2 { margin: 0; font-size: 22px; }
.sub { color: var(--sub); margin: 4px 0 24px; font-size: 14px; }
.hint { color: var(--faint); font-size: 12.5px; line-height: 1.7; margin: 18px 0 0; }
</style>
