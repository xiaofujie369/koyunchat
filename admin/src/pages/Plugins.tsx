import * as React from 'react'
import { Mail, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import MailCompose from '@/components/MailCompose'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import type { Row } from '@/lib/types'

const SEC: Record<string, string> = { ssl: 'SSL/TLS（一般是 465 端口）', starttls: 'STARTTLS（一般是 587 端口）', none: '不加密（一般是 25 端口）' }
const NEW_SENDER = { name: '', host: '', port: 465, security: 'ssl', username: '', password: '', from_addr: '', from_name: '', is_default: false }

export default function Plugins() {
  const [list, setList] = React.useState<Row[]>([])
  const load = async () => { try { setList(await api('GET', '/api/plugins')) } catch (e) { toast.error(errMsg(e)) } }
  React.useEffect(() => { load() }, [])
  const toggle = async (p: Row) => {
    try {
      setList(await api('PUT', '/api/plugins/' + p.code, { enabled: !p.enabled }))
      useStore.getState().set(s => ({ plugins: { ...s.plugins, [p.code]: !p.enabled } }))
      toast.success(p.enabled ? '已停用' : '已启用')
    } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <div className="mx-auto max-w-[960px] space-y-3">
      <p className="text-[13px] text-muted-foreground">插件可以单独启用、停用。点击插件展开它的设置。</p>
      {list.map(p => (
        <Section key={p.code} id={'plugin_' + p.code} defaultOpen={p.enabled} icon={p.code === 'mail' ? <Mail /> : <span>{p.icon}</span>}
          title={<span className="flex items-center gap-2">{p.name}<Badge>v{p.version}</Badge><Badge tone={p.enabled ? 'ok' : 'default'}>{p.enabled ? '已启用' : '未启用'}</Badge></span>}
          summary={p.description}
          badge={<span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><Switch checked={!!p.enabled} onCheckedChange={() => toggle(p)} title={p.enabled ? '点击停用' : '点击启用'} /></span>}>
          <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">{p.description}</p>
          {p.code === 'mail' && (p.enabled ? <MailPlugin /> : <p className="text-sm text-faint">打开右上角的开关启用后，在这里管理发件邮箱和发送记录。</p>)}
        </Section>
      ))}
    </div>
  )
}

function MailPlugin() {
  const me = useStore(s => s.user)
  const [senders, setSenders] = React.useState<Row[]>([])
  const [logs, setLogs] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const [tester, setTester] = React.useState<Row | null>(null)
  const [testTo, setTestTo] = React.useState(me?.email || '')
  const [testMsg, setTestMsg] = React.useState('')
  const [testing, setTesting] = React.useState(false)
  const [view, setView] = React.useState<Row | null>(null)
  const [compose, setCompose] = React.useState(false)
  const loadLogs = async () => { try { setLogs(await api('GET', '/api/mail/logs')) } catch { /* 忽略 */ } }
  React.useEffect(() => { api('GET', '/api/mail/senders').then(setSenders).catch(e => toast.error(errMsg(e))); loadLogs() }, [])
  const up = (k: string, v: unknown) => setCur(c => ({ ...c!, [k]: v }))
  const save = async () => {
    const c = cur!
    if (!c.from_addr.trim() || !c.host.trim()) return toast.error('请填写发件地址和 SMTP 服务器')
    try {
      setSenders(await api(c.id ? 'PUT' : 'POST', '/api/mail/senders' + (c.id ? '/' + c.id : ''),
        { name: c.name, host: c.host.trim(), port: Number(c.port), security: c.security, username: c.username.trim(), password: c.password, from_addr: c.from_addr.trim(), from_name: c.from_name, is_default: !!c.is_default }))
      setCur(null); toast.success('已保存，建议点「测试」确认能发出去')
    } catch (e) { toast.error(errMsg(e)) }
  }
  const del = async (x: Row) => { if (!confirm('删除发件邮箱 ' + x.from_addr + '？')) return; try { setSenders(await api('DELETE', '/api/mail/senders/' + x.id)); toast.success('已删除') } catch (e) { toast.error(errMsg(e)) } }
  const runTest = async () => {
    setTesting(true); setTestMsg('')
    try { await api('POST', '/api/mail/senders/' + tester!.id + '/test', { to: testTo }); setTestMsg('✅ 已发出，请到收件箱（或垃圾邮件箱）查看') } catch (e) { setTestMsg('❌ ' + errMsg(e)) }
    setTesting(false)
  }
  const delLog = async (l: Row) => { if (!confirm('删除这条发送记录？')) return; try { await api('DELETE', '/api/mail/logs/' + l.id); loadLogs() } catch (e) { toast.error(errMsg(e)) } }
  const from = (x: Row) => (x.from_name ? `${x.from_name} <${x.from_addr}>` : x.from_addr)
  return (
    <>
      <div className="mb-2 flex items-center gap-2"><b className="flex-1 text-sm">发件邮箱</b>
        <Button variant="outline" onClick={() => setCompose(true)} disabled={!senders.length}><Send />写邮件</Button>
        <Button onClick={() => setCur({ ...NEW_SENDER })}><Plus />添加发件邮箱</Button></div>
      <Table>
        <thead><tr><Th>名称</Th><Th>发件地址</Th><Th>SMTP 服务器</Th><Th>加密</Th><Th /></tr></thead>
        <tbody>
          {senders.map(x => (
            <Tr key={x.id}><Td>{x.name} {!!x.is_default && <Badge tone="accent">默认</Badge>}</Td><Td>{from(x)}</Td>
              <Td className="text-xs">{x.host}:{x.port}</Td><Td className="text-xs">{(SEC[x.security] || '').split('（')[0]}</Td>
              <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => { setTester(x); setTestMsg('') }}>测试</Button> <Button size="xs" variant="outline" onClick={() => setCur({ ...x, password: '' })}>修改</Button> <Button size="xs" variant="danger" onClick={() => del(x)}>删除</Button></Td></Tr>
          ))}
          {!senders.length && <Tr><Td colSpan={5} className="py-6 text-center text-faint">还没有发件邮箱，点右上角「添加发件邮箱」</Td></Tr>}
        </tbody>
      </Table>
      <div className="mt-6 mb-2 flex items-center gap-2"><b className="text-sm">发送记录</b><span className="text-xs text-faint">最近 100 封</span></div>
      <Table>
        <thead><tr><Th>时间</Th><Th>收件人</Th><Th>主题</Th><Th>发件人</Th><Th>客服</Th><Th>结果</Th><Th /></tr></thead>
        <tbody>
          {logs.map(l => (
            <Tr key={l.id}><Td className="text-xs">{fmtTime(l.created_at)}</Td><Td>{l.to_addr}</Td>
              <Td><button className="cursor-pointer text-left text-accent hover:underline" onClick={() => setView(l)}>{l.subject}</button></Td>
              <Td className="text-xs">{l.from_addr}</Td><Td className="text-xs">{l.user_name}</Td>
              <Td>{l.status === 'ok' ? <Badge tone="ok">成功</Badge> : <Badge tone="bad" title={l.error}>失败</Badge>}</Td>
              <Td><Button size="xs" variant="danger" onClick={() => delLog(l)}>删除</Button></Td></Tr>
          ))}
          {!logs.length && <Tr><Td colSpan={7} className="py-6 text-center text-faint">还没有发送记录</Td></Tr>}
        </tbody>
      </Table>

      {cur && (
        <Modal title={cur.id ? '修改发件邮箱' : '添加发件邮箱'} size="lg" onClose={() => setCur(null)} footer={<><Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={save}>保存</Button></>}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="名称（自己看的）"><Input value={cur.name} onChange={e => up('name', e.target.value)} placeholder="例如：客服邮箱" /></Field>
            <Field label="发件人名称（客户看到的）"><Input value={cur.from_name} onChange={e => up('from_name', e.target.value)} placeholder="例如：Koyun 客服" /></Field>
            <Field label="发件地址"><Input value={cur.from_addr} onChange={e => up('from_addr', e.target.value)} placeholder="support@example.com" /></Field>
            <Field label="SMTP 服务器"><Input value={cur.host} onChange={e => up('host', e.target.value)} placeholder="smtp.example.com" /></Field>
            <Field label="加密方式"><NativeSelect value={cur.security} onChange={e => setCur({ ...cur, security: e.target.value, port: ({ ssl: 465, starttls: 587, none: 25 } as Row)[e.target.value] })}>
              {Object.entries(SEC).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</NativeSelect></Field>
            <Field label="端口"><Input type="number" value={cur.port} onChange={e => up('port', e.target.value)} /></Field>
            <Field label="登录用户名"><Input value={cur.username} onChange={e => up('username', e.target.value)} placeholder="一般就是发件地址" autoComplete="off" /></Field>
            <Field label="密码 / 授权码"><Input type="password" autoComplete="new-password" value={cur.password} onChange={e => up('password', e.target.value)}
              placeholder={cur.id ? (cur.has_password ? '已设置，留空不修改，填 - 清除' : '未设置') : 'QQ、163 等邮箱要填授权码'} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.is_default} onChange={e => up('is_default', e.target.checked)} />设为默认发件邮箱</label>
        </Modal>
      )}
      {tester && (
        <Modal title="发送测试邮件" onClose={() => setTester(null)} footer={<><Button variant="outline" onClick={() => setTester(null)}>关闭</Button><Button onClick={runTest} disabled={testing}>{testing ? '发送中…' : '发送测试'}</Button></>}>
          <Field label={'用 ' + tester.from_addr + ' 发一封测试邮件到'} hint={<span data-test-result>{testMsg}</span>}><Input value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="你自己的邮箱" /></Field>
        </Modal>
      )}
      {view && (
        <Modal title={view.subject} size="lg" onClose={() => setView(null)}>
          <div className="mb-2.5 text-xs text-faint">{view.from_addr} → {view.to_addr} · {fmtTime(view.created_at)} · {view.user_name}</div>
          {view.error && <div className="mb-2.5 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">失败原因：{view.error}</div>}
          <div className="text-sm leading-relaxed whitespace-pre-wrap">{view.body}</div>
        </Modal>
      )}
      {compose && <MailCompose onClose={() => setCompose(false)} onSent={loadLogs} />}
    </>
  )
}
