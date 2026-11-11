import * as React from 'react'
import { Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Avatar, useTick } from '@/components/common'
import MailCompose from '@/components/MailCompose'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { EXT_LABEL, fmtDur, fmtTime, geoText, parseExt, visitorName } from '@/lib/format'
import type { Conv, Row } from '@/lib/types'

function Sec({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return <div className="border-b px-4 py-3.5 last:border-0">{title && <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">{title}</h4>}{children}</div>
}
function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1.5 text-[13px]">{rows.map(([k, v]) => <React.Fragment key={k}><div className="text-faint">{k}</div><div className="min-w-0 break-words">{v}</div></React.Fragment>)}</div>
}

// 访客资料面板（会话右栏、访客记录详情共用）
export default function VisitorPanel({ v, conv, onChanged }: { v: Row; conv?: Conv | null; onChanged?: () => void }) {
  useTick()
  const plugins = useStore(s => s.plugins)
  const [form, setForm] = React.useState({ name: v.name || '', email: v.email || '', notes: v.notes || '' })
  const [mailOpen, setMailOpen] = React.useState(false)
  const [mails, setMails] = React.useState<Row[]>([])
  React.useEffect(() => { setForm({ name: v.name || '', email: v.email || '', notes: v.notes || '' }) }, [v.id, v.name, v.email, v.notes])
  const loadMails = React.useCallback(async () => {
    if (!plugins.mail) return setMails([])
    try { setMails(await api('GET', '/api/mail/logs?visitor_id=' + encodeURIComponent(v.id))) } catch { setMails([]) }
  }, [v.id, plugins.mail])
  React.useEffect(() => { loadMails() }, [loadMails])

  const live = v.live
  const ext = parseExt(live ? live.ext : v.ext)
  const name = form.name || v.email || visitorName(v)
  const mailTo = /@/.test(form.email || ext.email || '') ? (form.email || ext.email).trim() : ''
  const save = async () => {
    if (form.name === (v.name || '') && form.email === (v.email || '') && form.notes === (v.notes || '')) return // 没改动不保存
    try { await api('PUT', '/api/visitors/' + v.id, form); toast.success('已保存'); onChanged?.() } catch (e) { toast.error(errMsg(e)) }
  }
  const block = async () => {
    if (!v.blocked && !confirm('屏蔽后该访客将无法再连接客服，确定？')) return
    try { await api('PUT', '/api/visitors/' + v.id, { blocked: !v.blocked }); onChanged?.() } catch (e) { toast.error(errMsg(e)) }
  }
  const pages: Row[] = v.pages || [], convs: Row[] = v.conversations || []
  return (
    <div>
      <Sec>
        <div className="flex flex-col items-center text-center">
          <Avatar name={name} seed={v.id} online={!!live} size="lg" />
          <div className="mt-2 font-semibold">{name}</div>
          <div className="text-xs text-faint">{live ? '在线 · 已停留 ' + fmtDur(Date.now() - live.connected_at) : '离线 · 最后访问 ' + fmtTime(v.last_seen)}</div>
        </div>
      </Sec>
      {live && <Sec title="正在浏览">
        <div className="text-[13px] font-medium">{live.title || '-'}</div>
        <a className="text-xs break-all" href={live.url} target="_blank" rel="noopener">{live.url}</a>
        <div className="text-xs text-faint">此页停留 {fmtDur(Date.now() - (live.page_since || live.connected_at))}</div>
      </Sec>}
      {Object.keys(ext).length > 0 && <Sec title={<>站点账户 <Badge tone="warn" title="由访客浏览器上报，仅供参考">浏览器上报</Badge></>}>
        <KV rows={Object.entries(ext).map(([k, val]) => [EXT_LABEL[k] || k, String(val)])} />
      </Sec>}
      <Sec title="访客资料">
        <Input className="mb-2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} onBlur={save} placeholder="称呼" />
        <Input className="mb-3" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} onBlur={save} placeholder="邮箱 / 联系方式" />
        <KV rows={[['IP', v.ip], ['位置', geoText(v)], ['设备', `${v.device} · ${v.os} · ${v.browser}`], ['语言', v.lang || '-'], ['访问次数', v.visits], ['首次访问', fmtTime(v.first_seen)], ['来源', v.referrer || '直接访问']]} />
      </Sec>
      <Sec title="备注"><Textarea className="min-h-16" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} onBlur={save} placeholder="仅客服可见" /></Sec>
      <Sec title="浏览轨迹">
        <div className="space-y-1.5 text-xs">
          {pages.map(p => <div key={p.ts}><a className="block truncate" href={p.url} target="_blank" rel="noopener" title={p.url}>{p.title || p.url}</a><div className="text-faint">{fmtTime(p.ts)}</div></div>)}
          {!pages.length && <div className="text-faint">无</div>}
        </div>
      </Sec>
      {convs.length > 1 && <Sec title="历史会话">
        <div className="space-y-1.5 text-xs">{convs.map(c => (
          <div key={c.id}><a href={'#/inbox/' + c.id}>#{c.id}</a> <Badge tone={c.status === 'open' ? 'ok' : 'default'}>{c.status === 'open' ? '进行中' : '已结束'}</Badge> <span className="text-faint">{fmtTime(c.last_at)}</span><div className="truncate text-faint">{c.last_msg}</div></div>
        ))}</div>
      </Sec>}
      {plugins.mail && <Sec title={<>邮件 {!live && <Badge>客户离线</Badge>}</>}>
        <Button size="xs" variant="outline" onClick={() => setMailOpen(true)}><Mail />发送邮件</Button>
        {mails.length > 0 && <div className="mt-2 space-y-1.5 text-xs">{mails.map(l => (
          <div key={l.id}><div className="truncate" title={l.body}>{l.subject}</div><div className="text-faint">{fmtTime(l.created_at)} · {l.to_addr} · {l.status === 'ok' ? '已发送' : '失败'}</div></div>
        ))}</div>}
      </Sec>}
      <Sec><Button size="xs" variant="danger" onClick={block}>{v.blocked ? '解除屏蔽' : '屏蔽访客'}</Button></Sec>
      {mailOpen && <MailCompose to={mailTo} name={form.name} visitorId={v.id} convId={conv?.id} onClose={() => setMailOpen(false)} onSent={loadMails} />}
    </div>
  )
}
