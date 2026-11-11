import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, Hint, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import type { Row } from '@/lib/types'

// 邮件插件：写邮件弹窗（会话、访客记录、插件页都能用）
export default function MailCompose({ to = '', name = '', visitorId = '', convId = 0, onClose, onSent }: {
  to?: string; name?: string; visitorId?: string; convId?: number; onClose: () => void; onSent?: () => void
}) {
  const me = useStore(s => s.user)
  const [senders, setSenders] = React.useState<Row[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [f, setF] = React.useState({ sender_id: 0, to, subject: '', body: (name ? name + '，您好：' : '您好：') + '\n\n\n\n' + (me?.name || '') })
  React.useEffect(() => {
    api<Row[]>('GET', '/api/mail/senders').then(l => {
      setSenders(l); const d = l.find(x => x.is_default) || l[0]; if (d) setF(x => ({ ...x, sender_id: d.id }))
    }).catch(e => { toast.error(errMsg(e)); setSenders([]) })
  }, [])
  const send = async () => {
    if (!f.to.trim() || !f.subject.trim() || !f.body.trim()) return toast.error('请填写收件地址、主题和正文')
    setBusy(true)
    try {
      await api('POST', '/api/mail/send', { ...f, sender_id: Number(f.sender_id), visitor_id: visitorId, conversation_id: convId || 0 })
      toast.success('邮件已发送'); onSent?.(); onClose()
    } catch (e) { toast.error(errMsg(e)) }
    setBusy(false)
  }
  const label = (x: Row) => (x.from_name ? `${x.from_name} <${x.from_addr}>` : x.from_addr) + (x.is_default ? '（默认）' : '')
  return (
    <Modal title="发送邮件" size="lg" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>取消</Button><Button onClick={send} disabled={busy || !senders?.length}>{busy ? '发送中…' : '发送'}</Button></>}>
      {senders && !senders.length && <Hint className="mb-3 text-warn">还没有发件邮箱，请管理员到「插件管理 → 邮件插件」添加。</Hint>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="发件邮箱"><NativeSelect value={f.sender_id} onChange={e => setF({ ...f, sender_id: Number(e.target.value) })}>
          {(senders || []).map(x => <option key={x.id} value={x.id}>{label(x)}</option>)}</NativeSelect></Field>
        <Field label="收件地址"><Input value={f.to} onChange={e => setF({ ...f, to: e.target.value })} placeholder="客户邮箱" /></Field>
      </div>
      <Field label="主题"><Input value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} placeholder="例如：关于您的咨询" /></Field>
      <Field label="正文"><Textarea className="min-h-52" value={f.body} onChange={e => setF({ ...f, body: e.target.value })} placeholder="邮件内容，换行会保留" /></Field>
    </Modal>
  )
}
