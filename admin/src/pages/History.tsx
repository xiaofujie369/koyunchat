import * as React from 'react'
import { toast } from 'sonner'
import { Card, CardHeader, Empty } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { Avatar } from '@/components/common'
import VisitorPanel from '@/components/VisitorPanel'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime, geoText, parseExt, visitorName } from '@/lib/format'
import type { Row } from '@/lib/types'

export default function History() {
  const live = useStore(s => s.live)
  const [q, setQ] = React.useState('')
  const [list, setList] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const load = React.useCallback(async () => { try { setList(await api('GET', '/api/visitors?q=' + encodeURIComponent(q))) } catch (e) { toast.error(errMsg(e)) } }, [q])
  React.useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const detail = async (v: Row) => { try { setCur(await api('GET', '/api/visitors/' + v.id)) } catch (e) { toast.error(errMsg(e)) } }
  return (
    <Card>
      <CardHeader>访客记录<span className="flex-1" />
        <Input className="w-64" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索称呼 / 邮箱 / IP" onKeyDown={e => e.key === 'Enter' && load()} />
        <Button variant="outline" onClick={load}>搜索</Button>
      </CardHeader>
      <Table>
        <thead><tr><Th>访客</Th><Th>站点账户</Th><Th>位置 / IP</Th><Th>设备</Th><Th>访问</Th><Th>最后访问</Th><Th /></tr></thead>
        <tbody>
          {list.map(v => {
            const ext = parseExt(v.ext)
            return (
              <Tr key={v.id}>
                <Td><div className="flex items-center gap-2.5"><Avatar name={visitorName(v)} seed={v.id} online={!!live[v.id]} size="sm" /><div>{visitorName(v)}<div className="text-xs text-faint">{v.email}</div></div></div></Td>
                <Td className="text-xs">{ext.plan || '-'}{ext.expired_at && <div className="text-faint">到期 {ext.expired_at}</div>}</Td>
                <Td>{geoText(v)}<div className="text-xs text-faint">{v.ip}</div></Td>
                <Td className="text-xs">{v.device} · {v.os} · {v.browser}</Td>
                <Td>{v.visits} 次</Td>
                <Td className="text-xs">{fmtTime(v.last_seen)}</Td>
                <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => detail(v)}>详情</Button> {!!v.blocked && <Badge tone="bad">已屏蔽</Badge>}</Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {!list.length && <Empty>暂无数据</Empty>}
      {cur && <Modal title="访客详情" onClose={() => setCur(null)} size="lg"><VisitorPanel v={{ ...cur, live: live[cur.id] || null }} onChanged={() => { detail(cur); load() }} /></Modal>}
    </Card>
  )
}
