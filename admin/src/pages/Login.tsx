import * as React from 'react'
import { MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { useStore } from '@/lib/store'
import { bootstrap } from '@/lib/live'
import { errMsg } from '@/lib/api'

export default function Login() {
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '登录失败')
      useStore.getState().login(d.token)
      await bootstrap()
    } catch (x) { toast.error(errMsg(x)) }
    setBusy(false)
  }
  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="w-full max-w-[380px] rounded-2xl border bg-card p-8 shadow-sm">
        <div className="mb-5 grid size-12 place-items-center rounded-xl bg-accent text-white"><MessageCircle className="size-6" /></div>
        <h1 className="text-xl font-bold">Koyun Chat</h1>
        <p className="mb-6 text-sm text-muted-foreground">登录客服工作台</p>
        <form onSubmit={submit}>
          <Field label="邮箱"><Input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></Field>
          <Field label="密码"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
          <Button size="lg" className="mt-2 w-full" disabled={busy}>{busy ? '登录中…' : '登录'}</Button>
        </form>
      </div>
    </div>
  )
}
