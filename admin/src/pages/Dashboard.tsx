import * as React from 'react'
import { BellDot, Bot, Inbox, MessageSquareText, MessagesSquare, Smile, TrendingDown, TrendingUp, UserCheck, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/input'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import AreaChart from '@/components/AreaChart'
import { BarList } from '@/components/Charts'
import { Avatar } from '@/components/common'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Row } from '@/lib/types'

const METRICS = [['conversations', '会话数'], ['visitors', '访客数'], ['messages', '消息数']] as const
type Metric = (typeof METRICS)[number][0]

// 环比：和昨天 / 上月同期比
function Trend({ cur, prev, vs }: { cur: number; prev: number; vs: string }) {
  if (!prev && !cur) return <span className="text-faint">{vs}都没有数据</span>
  if (!prev) return <span className="text-faint">{vs}为 0</span>
  const p = ((cur - prev) / prev) * 100
  if (Math.abs(p) < 0.05) return <span className="text-faint">与{vs}持平</span>
  const up = p > 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={cn('size-3.5', up ? 'text-ok' : 'text-bad')} />
      <span className={cn('font-medium tabular-nums', up ? 'text-ok' : 'text-bad')}>{up ? '+' : ''}{p.toFixed(1)}%</span>
      <span className="text-faint">较{vs}</span>
    </span>
  )
}

function StatCard({ title, icon, value, sub, highlight }: { title: string; icon: React.ReactNode; value: React.ReactNode; sub: React.ReactNode; highlight?: boolean }) {
  return (
    <Card className={cn('px-3.5 py-3 sm:px-5 sm:py-4', highlight && 'border-warn/50')}>
      <div className="flex items-start justify-between gap-2"><span className="text-[13px] font-medium text-muted-foreground">{title}</span><span className="text-faint [&_svg]:size-[18px]">{icon}</span></div>
      <div className="mt-2 text-[22px] leading-tight font-bold tabular-nums sm:text-[28px]">{value}</div>
      <div className="mt-1 text-xs">{sub}</div>
    </Card>
  )
}

function fmtMs(ms: number) {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
  return (s / 3600).toFixed(1) + ' 小时'
}

export default function Dashboard() {
  const live = useStore(s => s.live)
  const [days, setDays] = React.useState(30)
  const [metric, setMetric] = React.useState<Metric>('conversations')
  const [table, setTable] = React.useState(false)
  const [d, setD] = React.useState<Row | null>(null)
  const load = React.useCallback(async () => {
    try { setD(await api('GET', `/api/stats/overview?days=${days}&tz=${-new Date().getTimezoneOffset()}`)) } catch (e) { toast.error(errMsg(e)) }
  }, [days])
  React.useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t) }, [load])

  if (!d) return <div className="py-20 text-center text-sm text-faint">加载统计数据…</div>
  const c = d.cards, s = d.summary
  const series: Row[] = d.series
  const metricName = METRICS.find(m => m[0] === metric)![1]
  const points = series.map(x => ({ label: x.date, value: x[metric], extra: metric === 'messages' ? `其中 AI 回复 ${x.ai}` : undefined }))
  const replies = s.agent_replies + s.ai_replies
  const onlineNow = Object.keys(live).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 xl:grid-cols-4">
        <StatCard title="今日会话" icon={<MessagesSquare />} value={c.today_convs} sub={<Trend cur={c.today_convs} prev={c.yesterday_convs} vs="昨天同一时间" />} />
        <StatCard title="本月会话" icon={<MessageSquareText />} value={c.month_convs} sub={<Trend cur={c.month_convs} prev={c.last_month_convs} vs="上月同期" />} />
        <StatCard title="待接待" icon={<Inbox />} value={c.unassigned} highlight={c.unassigned > 0}
          sub={<span className="text-muted-foreground">进行中 {c.open} 个{c.unassigned > 0 && <>，<a href="#/inbox">有会话还没人接</a></>}</span>} />
        <StatCard title="未读消息" icon={<BellDot />} value={c.unread} highlight={c.unread > 0}
          sub={<span className="text-muted-foreground">{c.unread ? `分布在 ${c.unread_convs} 个会话里` : '全部已读'}</span>} />
        <StatCard title="今日访客" icon={<Users />} value={c.today_visitors} sub={<Trend cur={c.today_visitors} prev={c.yesterday_visitors} vs="昨天同一时间" />} />
        <StatCard title="访客总数" icon={<UserCheck />} value={c.visitors_total} sub={<span className="text-muted-foreground">当前在线 {onlineNow} 人 · 在线客服 {c.online_agents} 人</span>} />
        <StatCard title="今日消息" icon={<Bot />} value={c.today_msgs} sub={<span className="inline-flex flex-wrap items-center gap-x-2"><Trend cur={c.today_msgs} prev={c.yesterday_msgs} vs="昨天" /><span className="text-faint">AI 回复 {c.today_ai}</span></span>} />
        <StatCard title="本月满意度" icon={<Smile />} value={c.rated_month ? c.rating_month.toFixed(1) + ' / 5' : '—'}
          sub={<span className="text-muted-foreground">{c.rated_month ? `${c.rated_month} 次评分` : '本月还没有评分'}{c.rating_all ? ` · 历史平均 ${c.rating_all.toFixed(1)}` : ''}</span>} />
      </div>

      <Card>
        <div className="flex flex-wrap items-start gap-3 px-5 pt-4">
          <div className="flex-1">
            <div className="text-[15px] font-semibold">数据概览</div>
            <div className="text-xs text-faint">{s.from} 至 {s.to}</div>
          </div>
          <NativeSelect className="w-28" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option>
          </NativeSelect>
          <div className="flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="选择指标">
            {METRICS.map(([k, t]) => (
              <button key={k} role="tab" aria-selected={metric === k} onClick={() => setMetric(k)}
                className={cn('cursor-pointer rounded-md px-3 py-1.5 text-[13px]', metric === k ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground')}>{t}</button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setTable(v => !v)}>{table ? '看图表' : '看表格'}</Button>
        </div>
        <div className="grid grid-cols-2 gap-4 px-5 pt-4 pb-1 lg:grid-cols-4">
          <div><div className="text-xs text-muted-foreground">区间{metricName}</div><div className="text-2xl font-bold tabular-nums">{s[metric]}</div>
            <div className="text-xs text-faint">日均 {(s[metric] / d.days).toFixed(1)}</div></div>
          <div><div className="text-xs text-muted-foreground">回复（客服 / AI）</div><div className="text-2xl font-bold tabular-nums">{s.agent_replies} <span className="text-base font-medium text-faint">/ {s.ai_replies}</span></div>
            <div className="text-xs text-faint">AI 占比 {replies ? Math.round((s.ai_replies / replies) * 100) : 0}%</div></div>
          <div><div className="text-xs text-muted-foreground">平均首次响应</div><div className="text-2xl font-bold tabular-nums">{fmtMs(s.first_response_ms)}</div>
            <div className="text-xs text-faint">访客发消息到第一条回复，{s.responded} 个会话</div></div>
          <div><div className="text-xs text-muted-foreground">区间满意度</div><div className="text-2xl font-bold tabular-nums">{s.rated ? s.rating.toFixed(1) : '—'}</div>
            <div className="text-xs text-faint">{s.rated} 次评分，共 {s.conversations} 个会话</div></div>
        </div>
        <CardBody className="pt-2">
          {table ? (
            <div className="max-h-[300px] overflow-y-auto">
              <Table>
                <thead><tr><Th>日期</Th><Th className="text-right">会话</Th><Th className="text-right">访客</Th><Th className="text-right">消息</Th><Th className="text-right">AI 回复</Th></tr></thead>
                <tbody>{[...series].reverse().map(x => (
                  <Tr key={x.date}><Td>{x.date}</Td><Td className="text-right tabular-nums">{x.conversations}</Td><Td className="text-right tabular-nums">{x.visitors}</Td><Td className="text-right tabular-nums">{x.messages}</Td><Td className="text-right tabular-nums">{x.ai}</Td></Tr>
                ))}</tbody>
              </Table>
            </div>
          ) : <AreaChart data={points} name={metricName} />}
        </CardBody>
      </Card>

      <div className="grid gap-3.5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>客服工作量<span className="text-xs font-normal text-faint">近 {d.days} 天</span></CardHeader>
          <Table>
            <thead><tr><Th>客服</Th><Th className="text-right">接待会话</Th><Th className="text-right">回复消息</Th><Th className="text-right">平均评分</Th><Th className="text-right">当前进行中</Th></tr></thead>
            <tbody>{(d.agents as Row[]).map(a => (
              <Tr key={a.id}>
                <Td><div className="flex items-center gap-2.5"><Avatar name={a.name} online={!!a.online} size="sm" />{a.name}{a.role === 'admin' && <Badge>管理员</Badge>}</div></Td>
                <Td className="text-right tabular-nums">{a.conversations}</Td><Td className="text-right tabular-nums">{a.replies}</Td>
                <Td className="text-right tabular-nums">{a.rating ? a.rating.toFixed(1) : '—'}</Td><Td className="text-right tabular-nums">{a.open_now}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card><CardHeader>站点会话分布<span className="text-xs font-normal text-faint">近 {d.days} 天</span></CardHeader><CardBody><BarList rows={d.sites} empty="还没有会话" /></CardBody></Card>
        <Card><CardHeader>访客地区</CardHeader><CardBody><BarList rows={d.countries} empty="还没有访客" /></CardBody></Card>
        <Card><CardHeader>访客来源</CardHeader><CardBody><BarList rows={d.referrers} empty="还没有访客" /></CardBody></Card>
        <Card>
          <CardHeader>接入指引</CardHeader>
          <CardBody>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
              <li>在 <a href="#/sites">站点管理</a> 创建站点，复制嵌入代码，放到网站页面的 &lt;/body&gt; 前。</li>
              <li>在 <a href="#/settings">系统设置</a> 填入 AI 接口和 Key，开启 AI 接待和回复建议。</li>
              <li>在 <a href="#/agents">客服成员</a> 添加同事，在 <a href="#/team">团队协作</a> 里沟通。</li>
            </ol>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
