import * as React from 'react'
import { toast } from 'sonner'
import { Card, CardHeader, Empty } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { Avatar, useTick } from '@/components/common'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtDur, geoText, parseExt, visitorName } from '@/lib/format'
import { go } from '@/lib/live'
import type { Live } from '@/lib/types'

export default function Visitors() {
  useTick()
  const { live, sites, peek } = useStore()
  const [site, setSite] = React.useState('0')
  const list = Object.values(live).filter(v => site === '0' || String(v.site_id) === site).sort((a, b) => b.connected_at - a.connected_at)
  const siteName = (id: number) => sites.find(s => s.id === id)?.name || ''
  const chat = async (v: Live) => {
    if (v.conversation_id) return go('inbox/' + v.conversation_id)
    try { const r = await api('POST', '/api/visitors/' + v.id + '/chat'); go('inbox/' + r.id) } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <Card>
      <CardHeader>实时访客 <Badge tone="ok">{list.length} 人在线</Badge><span className="flex-1" />
        <NativeSelect className="w-40" value={site} onChange={e => setSite(e.target.value)}>
          <option value="0">全部站点</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
      </CardHeader>
      <Table>
        <thead><tr><Th>访客</Th><Th>当前页面</Th><Th>位置 / IP</Th><Th>设备</Th><Th>本次停留</Th><Th>页数</Th><Th>站点</Th><Th /></tr></thead>
        <tbody>
          {list.map(v => {
            const ext = parseExt(v.ext)
            return (
              <Tr key={v.id}>
                <Td><div className="flex items-center gap-2.5"><Avatar name={visitorName(v)} seed={v.id} online size="sm" />
                  <div><div className="font-medium">{visitorName(v)}</div>
                    {ext.plan && <div className="text-xs text-faint">{ext.plan} · 到期 {ext.expired_at}</div>}
                    {peek[v.id] && <div className="text-xs text-warn">正在输入：{peek[v.id]}</div>}</div></div></Td>
                <Td className="max-w-[280px]"><div className="truncate" title={v.title}>{v.title || '-'}</div>
                  <a className="block truncate text-xs" href={v.url} target="_blank" rel="noopener" title={v.url}>{v.url}</a>
                  <div className="text-xs text-faint">停留 {fmtDur(Date.now() - (v.page_since || v.connected_at))}</div></Td>
                <Td><div>{geoText(v)}</div><div className="text-xs text-faint">{v.ip}</div></Td>
                <Td className="text-xs">{v.device} · {v.os}<br /><span className="text-faint">{v.browser}</span></Td>
                <Td className="text-xs">{fmtDur(Date.now() - v.connected_at)}<div className="text-faint">第 {v.visits} 次访问</div></Td>
                <Td>{v.pages}</Td>
                <Td><Badge>{siteName(v.site_id)}</Badge></Td>
                <Td><Button size="xs" variant={v.chatting ? 'outline' : 'accent'} onClick={() => chat(v)}>{v.chatting ? '查看会话' : '发起对话'}</Button></Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {!list.length && <Empty>暂无在线访客</Empty>}
    </Card>
  )
}
