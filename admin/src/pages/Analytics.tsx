import * as React from 'react'
import { ChevronRight, Download, Eye, Globe2, MapPin, MessageCircle, Network, RotateCcw, Timer, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader, Empty } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import AreaChart from '@/components/AreaChart'
import { BarList, ColumnChart, Delta, exportCSV } from '@/components/Charts'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { go } from '@/lib/live'
import { cn } from '@/lib/utils'
import type { Row } from '@/lib/types'

const DAY = 86400000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 快捷时间范围（都按浏览器本地时间）
const PRESETS: { k: string; label: string; range: () => [Date, Date] }[] = [
  { k: 'today', label: '今天', range: () => { const s = startOfDay(new Date()); return [s, new Date(s.getTime() + DAY)] } },
  { k: 'yesterday', label: '昨天', range: () => { const s = startOfDay(new Date()); return [new Date(s.getTime() - DAY), s] } },
  { k: '7d', label: '近 7 天', range: () => { const e = new Date(startOfDay(new Date()).getTime() + DAY); return [new Date(e.getTime() - 7 * DAY), e] } },
  { k: '30d', label: '近 30 天', range: () => { const e = new Date(startOfDay(new Date()).getTime() + DAY); return [new Date(e.getTime() - 30 * DAY), e] } },
  { k: 'month', label: '本月', range: () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth(), 1), new Date(n.getFullYear(), n.getMonth() + 1, 1)] } },
  { k: 'lastmonth', label: '上月', range: () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 1)] } },
  { k: '90d', label: '近 90 天', range: () => { const e = new Date(startOfDay(new Date()).getTime() + DAY); return [new Date(e.getTime() - 90 * DAY), e] } },
  { k: 'year', label: '今年', range: () => { const n = new Date(); return [new Date(n.getFullYear(), 0, 1), new Date(n.getFullYear() + 1, 0, 1)] } },
]
const METRICS = [['pv', '浏览量'], ['uv', '访客数'], ['new', '新访客'], ['ips', '独立 IP'], ['conversations', '咨询会话']] as const
type Metric = (typeof METRICS)[number][0]
const GRANS: [string, string][] = [['', '自动'], ['hour', '按小时'], ['day', '按日'], ['week', '按周'], ['month', '按月']]
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtDur(ms: number) {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? s + ' 秒' : s < 3600 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : (s / 3600).toFixed(1) + ' 小时'
}
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—')

function Kpi({ icon, title, value, cur, prev, hint }: { icon: React.ReactNode; title: string; value: React.ReactNode; cur?: number; prev?: number; hint?: string }) {
  return (
    <Card className="px-3.5 py-3 sm:px-5 sm:py-4">
      <div className="flex items-start justify-between gap-2"><span className="text-[13px] font-medium text-muted-foreground" title={hint}>{title}</span><span className="text-faint [&_svg]:size-[18px]">{icon}</span></div>
      <div className="mt-1.5 text-[22px] leading-tight font-bold tabular-nums sm:text-[26px]">{value}</div>
      <div className="mt-1 text-xs">{cur !== undefined && prev !== undefined ? <Delta cur={cur} prev={prev} /> : <span className="text-faint">{hint}</span>}</div>
    </Card>
  )
}

export default function Analytics() {
  const sites = useStore(s => s.sites)
  const [preset, setPreset] = React.useState('30d')
  const [custom, setCustom] = React.useState<[string, string]>(() => { const [a, b] = PRESETS[3].range(); return [ymd(a), ymd(new Date(b.getTime() - DAY))] })
  const [site, setSite] = React.useState('0')
  const [gran, setGran] = React.useState('')
  const [metric, setMetric] = React.useState<Metric>('uv')
  const [table, setTable] = React.useState(false)
  const [d, setD] = React.useState<Row | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [country, setCountry] = React.useState<string | null>(null)

  const range = React.useMemo<[number, number]>(() => {
    if (preset === 'custom') {
      const a = new Date(custom[0] + 'T00:00:00'), b = new Date(custom[1] + 'T00:00:00')
      return [a.getTime(), b.getTime() + DAY]
    }
    const [a, b] = PRESETS.find(p => p.k === preset)!.range()
    return [a.getTime(), b.getTime()]
  }, [preset, custom])
  const qs = `from=${range[0]}&to=${range[1]}&site=${site}&tz=${-new Date().getTimezoneOffset()}`

  // 快速切换条件时会同时有几个请求在路上，只用最后一个的结果，免得旧结果晚到把新结果盖掉
  React.useEffect(() => {
    if (!(range[1] > range[0])) return
    let stale = false
    setLoading(true)
    api('GET', `/api/analytics?${qs}&gran=${gran}`)
      .then(r => { if (!stale) setD(r) })
      .catch(e => { if (!stale) toast.error(errMsg(e)) })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [qs, gran]) // eslint-disable-line react-hooks/exhaustive-deps

  const t = d?.totals || {}, p = d?.prev || {}
  const series: Row[] = d?.series || []
  const g: string = d?.gran || 'day'
  const metricName = METRICS.find(m => m[0] === metric)![1]
  const fmtLabel = (l: string) => (g === 'hour' ? l.slice(11) : g === 'month' ? l : g === 'week' ? l.slice(5) + ' 周' : l.slice(5))
  const fullLabel = (l: string) => (g === 'week' ? l + ' 这一周' : l)
  const toHistory = (params: Record<string, string>) => {
    const sp = new URLSearchParams({ from: String(range[0]), to: String(range[1]), ...(site !== '0' ? { site } : {}), ...params })
    go('history?' + sp.toString())
  }

  return (
    <div className="space-y-4">
      {/* 筛选：一行放在所有图表上面 */}
      <Card className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {PRESETS.map(x => (
            <button key={x.k} onClick={() => setPreset(x.k)} className={cn('cursor-pointer rounded-lg px-2.5 py-1.5 text-[13px]', preset === x.k ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>{x.label}</button>
          ))}
          <button onClick={() => setPreset('custom')} className={cn('cursor-pointer rounded-lg px-2.5 py-1.5 text-[13px]', preset === 'custom' ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>自定义</button>
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-1.5">
            <Input type="date" className="w-[150px]" value={custom[0]} max={custom[1]} onChange={e => setCustom([e.target.value, custom[1]])} />
            <span className="text-faint">至</span>
            <Input type="date" className="w-[150px]" value={custom[1]} min={custom[0]} onChange={e => setCustom([custom[0], e.target.value])} />
          </div>
        )}
        <span className="flex-1" />
        <NativeSelect className="w-32" value={site} onChange={e => setSite(e.target.value)} aria-label="站点">
          <option value="0">全部站点</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
        <NativeSelect className="w-28" value={gran} onChange={e => setGran(e.target.value)} aria-label="统计粒度">
          {GRANS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </NativeSelect>
        {loading && <span className="text-xs text-faint">统计中…</span>}
      </Card>

      {!d ? <div className="py-20 text-center text-sm text-faint">统计中…</div> : <>
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 xl:grid-cols-4">
          <Kpi icon={<Eye />} title="浏览量（PV）" value={t.pv} cur={t.pv} prev={p.pv} />
          <Kpi icon={<Users />} title="访客数（UV）" value={t.uv} cur={t.uv} prev={p.uv} />
          <Kpi icon={<UserPlus />} title="新访客" value={t.new} cur={t.new} prev={p.new} />
          <Kpi icon={<RotateCcw />} title="回访访客" value={t.returning} cur={t.returning} prev={p.returning} />
          <Kpi icon={<Network />} title="独立 IP" value={t.ips} cur={t.ips} prev={p.ips} />
          <Kpi icon={<Globe2 />} title="人均浏览页数" value={t.uv ? (t.pv / t.uv).toFixed(1) : '—'} hint={`只看 1 页就离开：${pct(t.single_page, t.uv)}`} />
          <Kpi icon={<Timer />} title="平均浏览时长" value={fmtDur(t.avg_duration_ms)} hint="按同一天第一页到最后一页的间隔估算" />
          <Kpi icon={<MessageCircle />} title="咨询转化率" value={pct(t.chat_visitors, t.uv)} hint={`${t.chat_visitors} 位访客发起了 ${t.conversations} 个会话`} />
        </div>

        <Card>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
            <div className="flex-1"><div className="text-[15px] font-semibold">访问趋势</div>
              <div className="text-xs text-faint">{ymd(new Date(range[0]))} 至 {ymd(new Date(range[1] - 1))} · {GRANS.find(x => x[0] === g)?.[1]}</div></div>
            <div className="flex flex-wrap rounded-lg bg-muted p-0.5" role="tablist" aria-label="选择指标">
              {METRICS.map(([k, l]) => <button key={k} role="tab" aria-selected={metric === k} onClick={() => setMetric(k)} className={cn('cursor-pointer rounded-md px-2.5 py-1.5 text-[13px]', metric === k ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground')}>{l}</button>)}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setTable(v => !v)}>{table ? '看图表' : '看表格'}</Button>
            <Button size="sm" variant="ghost" title="导出 CSV" onClick={() => exportCSV('访问趋势', ['时间', '浏览量', '访客数', '新访客', '独立IP', '咨询会话'], series.map(x => [x.key, x.pv, x.uv, x.new, x.ips, x.conversations]))}><Download /></Button>
          </div>
          <CardBody className="pt-3">
            {table ? (
              <div className="max-h-[320px] overflow-y-auto">
                <Table>
                  <thead><tr><Th>时间</Th><Th className="text-right">浏览量</Th><Th className="text-right">访客数</Th><Th className="text-right">新访客</Th><Th className="text-right">独立 IP</Th><Th className="text-right">咨询会话</Th></tr></thead>
                  <tbody>{[...series].reverse().map(x => <Tr key={x.key}><Td>{fullLabel(x.key)}</Td>{['pv', 'uv', 'new', 'ips', 'conversations'].map(k => <Td key={k} className="text-right tabular-nums">{x[k]}</Td>)}</Tr>)}</tbody>
                </Table>
              </div>
            ) : <AreaChart data={series.map(x => ({ label: fullLabel(x.key), value: x[metric] }))} name={metricName} fmtLabel={l => fmtLabel(l.replace(' 这一周', ''))} />}
            {range[1] > Date.now() && range[0] < Date.now() && <p className="mt-1 text-xs text-faint">最后一个点（{g === 'hour' ? '这个小时' : g === 'week' ? '本周' : g === 'month' ? '本月' : '今天'}）还没结束，数字会继续增加。</p>}
          </CardBody>
        </Card>

        {/* 地区：最想看的部分，放在最前面 */}
        <div className="grid gap-3.5 xl:grid-cols-5">
          <Card className="xl:col-span-3">
            <CardHeader><MapPin className="size-4 text-faint" />访客地区（国家 / 地区）<span className="text-xs font-normal text-faint">点击一行看省份和城市</span><span className="flex-1" />
              <Button size="xs" variant="ghost" onClick={() => exportCSV('访客地区', ['国家/地区', '访客数', '浏览量', '独立IP', '新访客', '咨询人数'], (d.countries as Row[]).map(c => [c.name, c.uv, c.pv, c.ips, c.new, c.chats]))}><Download />导出</Button></CardHeader>
            <div className="max-h-[440px] overflow-y-auto">
              <Table>
                <thead><tr><Th>#</Th><Th>国家 / 地区</Th><Th className="w-[28%]">访客占比</Th><Th className="text-right">访客</Th><Th className="text-right">浏览量</Th><Th className="text-right">IP</Th><Th className="text-right">新访客</Th><Th className="text-right">咨询</Th><Th /></tr></thead>
                <tbody>{(d.countries as Row[]).map((c, i) => (
                  <Tr key={c.name} className="cursor-pointer" onClick={() => setCountry(c.name)}>
                    <Td className="text-faint">{i + 1}</Td><Td className="font-medium">{c.name}</Td>
                    <Td><div className="flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-chart" style={{ width: (c.uv / Math.max(1, d.countries[0].uv)) * 100 + '%' }} /></div><span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{pct(c.uv, t.uv)}</span></div></Td>
                    <Td className="text-right tabular-nums">{c.uv}</Td><Td className="text-right tabular-nums">{c.pv}</Td><Td className="text-right tabular-nums">{c.ips}</Td>
                    <Td className="text-right tabular-nums">{c.new}</Td><Td className="text-right tabular-nums">{c.chats || 0}</Td><Td><ChevronRight className="size-4 text-faint" /></Td>
                  </Tr>
                ))}</tbody>
              </Table>
              {!d.countries.length && <Empty>这段时间没有访客</Empty>}
            </div>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader>省份 / 城市排行<span className="text-xs font-normal text-faint">按访客数</span></CardHeader>
            <CardBody className="space-y-5">
              <div><div className="mb-2 text-xs font-semibold text-muted-foreground">省份 / 州</div><BarList rows={d.regions} valueKey="uv" empty="暂无数据" /></div>
              <div><div className="mb-2 text-xs font-semibold text-muted-foreground">城市</div><BarList rows={d.cities} valueKey="uv" empty="暂无数据" /></div>
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card><CardHeader>一天里的访问时段<span className="text-xs font-normal text-faint">按浏览量，本地时间</span></CardHeader>
            <CardBody><ColumnChart values={d.hours} labels={Array.from({ length: 24 }, (_, i) => i + '点')} name="每小时浏览量" /></CardBody></Card>
          <Card><CardHeader>一周里的访问分布<span className="text-xs font-normal text-faint">按浏览量</span></CardHeader>
            <CardBody><ColumnChart values={[1, 2, 3, 4, 5, 6, 0].map(i => d.weekdays[i])} labels={[1, 2, 3, 4, 5, 6, 0].map(i => WEEK[i])} name="每周各天浏览量" /></CardBody></Card>
        </div>

        <IPTable qs={qs} toHistory={toHistory} />

        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card>
            <CardHeader>受访页面 Top 20<span className="flex-1" /><Button size="xs" variant="ghost" onClick={() => exportCSV('受访页面', ['页面标题', '地址', '浏览量', '访客数'], (d.pages as Row[]).map(x => [x.title, x.url, x.pv, x.uv]))}><Download />导出</Button></CardHeader>
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <thead><tr><Th>页面</Th><Th className="text-right">浏览量</Th><Th className="text-right">访客</Th></tr></thead>
                <tbody>{(d.pages as Row[]).map(x => (
                  <Tr key={x.url}><Td className="max-w-[340px]"><div className="truncate" title={x.title}>{x.title || '（无标题）'}</div><a href={x.url} target="_blank" rel="noopener" className="block truncate text-xs" title={x.url}>{x.url}</a></Td>
                    <Td className="text-right tabular-nums">{x.pv}</Td><Td className="text-right tabular-nums">{x.uv}</Td></Tr>
                ))}</tbody>
              </Table>
              {!d.pages.length && <Empty>暂无数据</Empty>}
            </div>
          </Card>
          <Card><CardHeader>访客来源<span className="text-xs font-normal text-faint">第一次进站时从哪里来，按访客数</span></CardHeader>
            <CardBody><BarList rows={d.referrers} valueKey="uv" /></CardBody></Card>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardHeader>设备</CardHeader><CardBody><BarList rows={d.devices} valueKey="uv" /></CardBody></Card>
          <Card><CardHeader>操作系统</CardHeader><CardBody><BarList rows={d.os} valueKey="uv" /></CardBody></Card>
          <Card><CardHeader>浏览器</CardHeader><CardBody><BarList rows={d.browsers} valueKey="uv" /></CardBody></Card>
          <Card><CardHeader>浏览器语言</CardHeader><CardBody><BarList rows={d.langs} valueKey="uv" /></CardBody></Card>
        </div>
        <p className="text-center text-xs text-faint">浏览记录保留 {d.retention_days} 天（可在 系统设置 → 访问统计 修改），更早的数据无法统计。访客数按浏览器识别，同一个人换设备会算成多位访客。</p>
      </>}
      {country && <RegionModal country={country} qs={qs} onClose={() => setCountry(null)} toHistory={toHistory} />}
    </div>
  )
}

// 国家下钻：省份和城市
function RegionModal({ country, qs, onClose, toHistory }: { country: string; qs: string; onClose: () => void; toHistory: (p: Record<string, string>) => void }) {
  const [r, setR] = React.useState<Row | null>(null)
  React.useEffect(() => {
    let stale = false
    api('GET', `/api/analytics/regions?${qs}&country=${encodeURIComponent(country)}`).then(r => { if (!stale) setR(r) }).catch(e => toast.error(errMsg(e)))
    return () => { stale = true }
  }, [country, qs])
  const tbl = (rows: Row[], title: string, onPick?: (x: Row) => void) => (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="max-h-[300px] overflow-y-auto rounded-lg border">
        <Table>
          <thead><tr><Th>{title}</Th><Th className="text-right">访客</Th><Th className="text-right">浏览量</Th><Th className="text-right">IP</Th></tr></thead>
          <tbody>{rows.map(x => <Tr key={x.name} className={onPick ? 'cursor-pointer' : ''} onClick={() => onPick?.(x)}><Td>{x.name}</Td><Td className="text-right tabular-nums">{x.uv}</Td><Td className="text-right tabular-nums">{x.pv}</Td><Td className="text-right tabular-nums">{x.ips}</Td></Tr>)}</tbody>
        </Table>
      </div>
    </div>
  )
  return (
    <Modal title={country + ' · 省份和城市'} size="xl" onClose={onClose} footer={<><Button variant="outline" onClick={() => toHistory({ country })}>查看这些访客</Button><Button onClick={onClose}>关闭</Button></>}>
      {!r ? <div className="py-10 text-center text-sm text-faint">统计中…</div> : (
        <div className="grid gap-4 md:grid-cols-2">
          {tbl(r.regions, '省份 / 州', x => toHistory({ country, region: x.name === '未知' ? '' : x.name }))}
          {tbl(r.cities, '城市')}
        </div>
      )}
      <p className="mt-3 text-xs text-faint">点击省份可以查看那里的访客。</p>
    </Modal>
  )
}

// IP 统计：搜索 IP 或地区，点击查看该 IP 的访客
function IPTable({ qs, toHistory }: { qs: string; toHistory: (p: Record<string, string>) => void }) {
  const [q, setQ] = React.useState('')
  const [rows, setRows] = React.useState<Row[]>([])
  const seq = React.useRef(0)
  const load = React.useCallback(() => {
    const my = ++seq.current
    api('GET', `/api/analytics/ips?${qs}&q=${encodeURIComponent(q)}`).then(r => { if (my === seq.current) setRows(r) }).catch(e => toast.error(errMsg(e)))
  }, [qs, q])
  React.useEffect(() => { load() }, [qs]) // eslint-disable-line react-hooks/exhaustive-deps
  const place = (x: Row) => [x.country, x.region, x.city].filter((v, i, a) => v && v !== '未知' && a.indexOf(v) === i).join(' ') || '未知'
  return (
    <Card>
      <CardHeader><Network className="size-4 text-faint" />IP 统计<span className="text-xs font-normal text-faint">按浏览量排序，最多 200 个</span><span className="flex-1" />
        <Input className="w-56" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} placeholder="搜索 IP / 国家 / 城市" />
        <Button size="sm" variant="outline" onClick={load}>搜索</Button>
        <Button size="xs" variant="ghost" onClick={() => exportCSV('IP统计', ['IP', '地区', '访客数', '浏览量', '最后访问', '邮箱'], rows.map(x => [x.ip, place(x), x.uv, x.pv, new Date(x.last_ts).toLocaleString(), x.email || '']))}><Download />导出</Button></CardHeader>
      <div className="max-h-[460px] overflow-y-auto">
        <Table>
          <thead><tr><Th>IP</Th><Th>地区</Th><Th className="text-right">访客</Th><Th className="text-right">浏览量</Th><Th>最后访问</Th><Th>账户</Th><Th /></tr></thead>
          <tbody>{rows.map(x => (
            <Tr key={x.ip}>
              <Td className="font-mono text-xs">{x.ip}{!!x.blocked && <Badge tone="bad" className="ml-1.5">已屏蔽</Badge>}</Td>
              <Td>{place(x)}</Td><Td className="text-right tabular-nums">{x.uv}</Td><Td className="text-right tabular-nums">{x.pv}</Td>
              <Td className="text-xs">{fmtTime(x.last_ts)}</Td><Td className="max-w-[180px] truncate text-xs text-muted-foreground">{x.email || '—'}</Td>
              <Td><Button size="xs" variant="outline" onClick={() => toHistory({ ip: x.ip })}>查看访客</Button></Td>
            </Tr>
          ))}</tbody>
        </Table>
        {!rows.length && <Empty>没有找到</Empty>}
      </div>
    </Card>
  )
}
