import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader, Empty } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/dialog'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { copyText } from '@/lib/format'
import type { Row } from '@/lib/types'

const DEFAULTS = { name: '', domains: '', color: '#7c6bd6', title: '在线客服', welcome: '您好，有什么可以帮您？', offline_msg: '客服暂时不在线，请留言，我们会尽快回复您。', position: 'right', ai_mode: 'off', ai_name: 'AI 助手', ai_prompt: '', knowledge: '', xboard: 0 }

export default function Sites() {
  const { user, ai, apiURL } = useStore()
  const isAdmin = user?.role === 'admin'
  const [list, setList] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const load = async () => { try { const l = await api('GET', '/api/sites'); setList(l); useStore.getState().set({ sites: l }) } catch (e) { toast.error(errMsg(e)) } }
  React.useEffect(() => { load() }, [])
  const embed = (s: Row) => `<script src="${apiURL}/widget.js" data-site="${s.site_key}" async></script>`
  const copy = (t: string) => copyText(t).then(() => toast.success('已复制'))
  const up = (k: string, v: unknown) => setCur(c => ({ ...c!, [k]: v }))
  const save = async () => {
    try { if (cur!.id) await api('PUT', '/api/sites/' + cur!.id, cur); else await api('POST', '/api/sites', cur); setCur(null); toast.success('已保存'); load() } catch (e) { toast.error(errMsg(e)) }
  }
  const del = async () => {
    if (prompt('删除站点会同时删除它的所有访客和会话记录。输入站点名称确认：') !== cur!.name) return
    try { await api('DELETE', '/api/sites/' + cur!.id); setCur(null); load() } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <p className="flex-1 text-[13px] text-muted-foreground">每个网站创建一个站点，所有站点的访客统一在工作台接待。</p>
        {isAdmin && <Button onClick={() => setCur({ ...DEFAULTS })}><Plus />新建站点</Button>}
      </div>
      <div className="grid gap-3.5 lg:grid-cols-2">
        {list.map(s => (
          <Card key={s.id}>
            <CardHeader><span className="size-2.5 rounded-full" style={{ background: s.color }} />{s.name}
              {s.ai_mode !== 'off' && <Badge tone="accent">AI {s.ai_mode === 'always' ? '优先接待' : '离线接待'}</Badge>}
              {!!s.xboard && <Badge tone="warn">Xboard</Badge>}
              <span className="flex-1" />{isAdmin && <Button size="xs" variant="outline" onClick={() => setCur({ ...DEFAULTS, ...s })}>设置</Button>}</CardHeader>
            <CardBody>
              <div className="mb-1.5 text-xs text-muted-foreground">嵌入代码（放在 &lt;/body&gt; 之前）：</div>
              <pre className="overflow-x-auto rounded-lg bg-[#1f1d1a] px-3 py-2.5 font-mono text-xs whitespace-pre-wrap break-all text-[#e9e6df]">{embed(s)}</pre>
              <div className="mt-2.5 flex items-center gap-3"><Button size="xs" variant="outline" onClick={() => copy(embed(s))}>复制代码</Button><span className="truncate text-xs text-faint">允许域名：{s.domains || '不限制'}</span></div>
            </CardBody>
          </Card>
        ))}
      </div>
      {!list.length && <Card><Empty>还没有站点</Empty></Card>}
      {cur && (
        <Modal title={cur.id ? '站点设置' : '新建站点'} size="lg" onClose={() => setCur(null)}
          footer={<>{cur.id && <Button variant="danger" className="mr-auto" onClick={del}>删除站点</Button>}<Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={save}>保存</Button></>}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="站点名称"><Input value={cur.name} onChange={e => up('name', e.target.value)} /></Field>
            <Field label="允许的域名" hint="逗号分隔，含子域名；留空不限制"><Input value={cur.domains} onChange={e => up('domains', e.target.value)} placeholder="www.example.com,example.org" /></Field>
            <Field label="窗口标题"><Input value={cur.title} onChange={e => up('title', e.target.value)} /></Field>
            <Field label="主题色"><div className="flex gap-2"><input type="color" value={cur.color} onChange={e => up('color', e.target.value)} className="h-9 w-11 cursor-pointer rounded border-0 bg-transparent" /><Input value={cur.color} onChange={e => up('color', e.target.value)} /></div></Field>
            <Field label="欢迎语"><Input value={cur.welcome} onChange={e => up('welcome', e.target.value)} /></Field>
            <Field label="按钮位置"><NativeSelect value={cur.position} onChange={e => up('position', e.target.value)}><option value="right">右下角</option><option value="left">左下角</option></NativeSelect></Field>
          </div>
          <Field label="离线提示" hint="没有客服在线且 AI 未接待时自动发送，并请访客留下联系方式"><Input value={cur.offline_msg} onChange={e => up('offline_msg', e.target.value)} /></Field>
          <Field hint="开启后，已登录 Xboard 的用户会自动带上邮箱、套餐、到期时间、流量、余额（从用户浏览器读取，不改动 Xboard）">
            <label className="flex items-center gap-3 text-sm font-medium">Xboard 用户识别 <Switch checked={!!cur.xboard} onCheckedChange={v => up('xboard', v ? 1 : 0)} /></label>
          </Field>
          <div className="my-4 border-t" />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="AI 接待模式" hint={!ai ? <span className="text-warn">尚未配置 AI Key，请先到系统设置</span> : undefined}>
              <NativeSelect value={cur.ai_mode} onChange={e => up('ai_mode', e.target.value)}>
                <option value="off">关闭（仅辅助客服）</option><option value="offline">客服全部离线时由 AI 接待</option><option value="always">AI 优先接待，人工随时接管</option>
              </NativeSelect></Field>
            <Field label="AI 名称"><Input value={cur.ai_name} onChange={e => up('ai_name', e.target.value)} /></Field>
          </div>
          <Field label="AI 补充指令"><Textarea value={cur.ai_prompt} onChange={e => up('ai_prompt', e.target.value)} placeholder="例如：称呼用户为'您'；涉及退款一律转人工；推荐年付套餐…" /></Field>
          <Field label="知识库" hint={`${(cur.knowledge || '').length} 字。内容越完整，AI 回答越准确；知识库没有的问题 AI 会转人工。`}>
            <Textarea className="min-h-56" value={cur.knowledge} onChange={e => up('knowledge', e.target.value)} placeholder="把常见问题、套餐说明、使用教程、客户端下载地址、售后政策等粘贴到这里。AI 只会根据这里的内容回答。" />
          </Field>
        </Modal>
      )}
    </div>
  )
}
