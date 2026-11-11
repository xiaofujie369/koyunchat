import * as React from 'react'
import { useSearchParams } from 'react-router'
import { Download, X } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardHeader, Empty } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { Avatar } from '@/components/common'
import { exportCSV } from '@/components/Charts'
import VisitorPanel from '@/components/VisitorPanel'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime, geoText, parseExt, visitorName } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Row } from '@/lib/types'

const DAY = 86400000
const today0 = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() }
// 按最后访问时间筛选
const PERIODS: [string, string, () => [number, number] | null][] = [
  ['all', '全部', () => null],
  ['today', '今天', () => [today0(), today0() + DAY]],
  ['7d', '近 7 天', () => [today0() - 6 * DAY, today0() + DAY]],
  ['30d', '近 30 天', () => [today0() - 29 * DAY, today0() + DAY]],
  ['month', '本月', () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth(), 1).getTime(), new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime()] }],
]

export default function History() {
  const { live, sites } = useStore()
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = React.useState('')
  const [list, setList] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const [loading, setLoading] = React.useState(false)
  const seq = React.useRef(0)
  // 筛选条件放在地址里，访问统计页点过来时直接带上；刷新页面也不会丢
  const f = { period: sp.get('period') || (sp.get('from') ? 'range' : 'all'), site: sp.get('site') || '0', country: sp.get('country') || '', region: sp.get('region') || '', ip: sp.get('ip') || '', from: sp.get('from') || '', to: sp.get('to') || '' }
  const setF = (patch: Record<string, string>) => {
    const n = new URLSearchParams(sp)
    Object.entries(patch).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k)))
    setSp(n, { replace: true })
  }

  const load = React.useCallback(async () => {
    const p = new URLSearchParams({ q })
    let range: [number, number] | null = null
    if (f.period === 'range' && f.from) range = [Number(f.from), Number(f.to)]
    else range = (PERIODS.find(x => x[0] === f.period) || PERIODS[0])[2]()
    if (range) { p.set('from', String(range[0])); p.set('to', String(range[1])) }
    for (const k of ['site', 'country', 'region', 'ip'] as const) if (f[k] && f[k] !== '0') p.set(k, f[k])
    const my = ++seq.current // 只用最后一次请求的结果
    setLoading(true)
    try { const r = await api('GET', '/api/visitors?' + p.toString()); if (my === seq.current) setList(r) } catch (e) { toast.error(errMsg(e)) }
    if (my === seq.current) setLoading(false)
  }, [q, sp]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { load() }, [sp]) // eslint-disable-line react-hooks/exhaustive-deps

  const detail = async (v: Row) => { try { setCur(await api('GET', '/api/visitors/' + v.id)) } catch (e) { toast.error(errMsg(e)) } }
  const chips: [string, string][] = []
  if (f.period === 'range' && f.from) chips.push(['range', `${new Date(Number(f.from)).toLocaleDateString()} 至 ${new Date(Number(f.to) - 1).toLocaleDateString()}`])
  if (f.country) chips.push(['country', '国家：' + f.country])
  if (f.region) chips.push(['region', '地区：' + f.region])
  if (f.ip) chips.push(['ip', 'IP：' + f.ip])
  const clearChip = (k: string) => setF(k === 'range' ? { from: '', to: '', period: '' } : { [k]: '' })

  return (
    <Card>
      <CardHeader className="gap-2">访客记录<Badge>{list.length >= 500 ? '前 500 位' : list.length + ' 位'}</Badge><span className="flex-1" />
        <Input className="w-56" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索称呼 / 邮箱 / IP" onKeyDown={e => e.key === 'Enter' && load()} />
        <Button variant="outline" onClick={load}>搜索</Button>
        <Button variant="ghost" size="sm" onClick={() => exportCSV('访客记录', ['访客', '邮箱', '套餐', 'IP', '国家', '地区', '城市', '设备', '系统', '浏览器', '访问次数', '首次访问', '最后访问'],
          list.map(v => { const e = parseExt(v.ext); return [visitorName(v), v.email, e.plan || '', v.ip, v.country, v.region, v.city, v.device, v.os, v.browser, v.visits, new Date(v.first_seen).toLocaleString(), new Date(v.last_seen).toLocaleString()] }))}><Download />导出</Button>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        <div className="flex flex-wrap gap-1">
          {PERIODS.map(([k, l]) => <button key={k} onClick={() => setF({ period: k === 'all' ? '' : k, from: '', to: '' })}
            className={cn('cursor-pointer rounded-lg px-2.5 py-1 text-[13px]', f.period === k ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>{l}</button>)}
        </div>
        <NativeSelect className="h-8 w-32" value={f.site} onChange={e => setF({ site: e.target.value === '0' ? '' : e.target.value })} aria-label="站点">
          <option value="0">全部站点</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
        <Input className="h-8 w-32" placeholder="国家，如 中国" defaultValue={f.country} key={'c' + f.country} onKeyDown={e => e.key === 'Enter' && setF({ country: (e.target as HTMLInputElement).value.trim() })} onBlur={e => e.target.value.trim() !== f.country && setF({ country: e.target.value.trim() })} />
        {chips.map(([k, l]) => <span key={k} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs text-accent">{l}<button className="cursor-pointer" onClick={() => clearChip(k)} title="去掉这个条件"><X className="size-3" /></button></span>)}
        {loading && <span className="text-xs text-faint">加载中…</span>}
      </div>
      <Table>
        <thead><tr><Th>访客</Th><Th>站点账户</Th><Th>位置 / IP</Th><Th>设备</Th><Th>访问</Th><Th>首次访问</Th><Th>最后访问</Th><Th /></tr></thead>
        <tbody>
          {list.map(v => {
            const ext = parseExt(v.ext)
            return (
              <Tr key={v.id}>
                <Td><div className="flex items-center gap-2.5"><Avatar name={visitorName(v)} seed={v.id} online={!!live[v.id]} size="sm" /><div>{visitorName(v)}<div className="text-xs text-faint">{v.email}</div></div></div></Td>
                <Td className="text-xs">{ext.plan || '-'}{ext.expired_at && <div className="text-faint">到期 {ext.expired_at}</div>}</Td>
                <Td>{geoText(v)}<div className="font-mono text-xs text-faint"><button className="cursor-pointer hover:text-accent" title="只看这个 IP" onClick={() => setF({ ip: v.ip })}>{v.ip}</button></div></Td>
                <Td className="text-xs">{v.device} · {v.os} · {v.browser}</Td>
                <Td>{v.visits} 次</Td>
                <Td className="text-xs">{fmtTime(v.first_seen)}</Td>
                <Td className="text-xs">{fmtTime(v.last_seen)}</Td>
                <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => detail(v)}>详情</Button> {!!v.blocked && <Badge tone="bad">已屏蔽</Badge>}</Td>
              </Tr>
            )
          })}
        </tbody>
      </Table>
      {!list.length && <Empty>{loading ? '加载中…' : '没有符合条件的访客'}</Empty>}
      {cur && <Modal title="访客详情" onClose={() => setCur(null)} size="lg"><VisitorPanel v={{ ...cur, live: live[cur.id] || null }} onChanged={() => { detail(cur); load() }} /></Modal>}
    </Card>
  )
}
