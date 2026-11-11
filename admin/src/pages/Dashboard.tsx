import * as React from 'react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader, Stat } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/common'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import type { Row } from '@/lib/types'

export default function Dashboard() {
  const { live, users } = useStore()
  const [st, setSt] = React.useState<Row>({})
  React.useEffect(() => { api('GET', '/api/stats').then(setSt).catch(e => toast.error(errMsg(e))) }, [])
  const days: Row[] = st.days || []
  const max = Math.max(1, ...days.map(d => Math.max(d.conversations, d.visitors)))
  const online = users.filter(u => u.online)
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">实时数据，WebSocket 推送。</p>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat k="在线访客" v={Object.keys(live).length} s="实时" />
        <Stat k="进行中会话" v={st.open || 0} s={'未分配 ' + (st.unassigned || 0)} />
        <Stat k="今日会话" v={st.today_conversations || 0} s={`消息 ${st.today_messages || 0} · AI 回复 ${st.today_ai || 0}`} />
        <Stat k="满意度" v={st.avg_rating ? st.avg_rating.toFixed(1) : '—'} s={`在线客服 ${online.length} 人`} />
      </div>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <Card>
          <CardHeader>近 7 天<span className="flex-1" /><Badge tone="accent">会话</Badge><Badge>访客</Badge></CardHeader>
          <CardBody>
            <div className="flex h-44 items-end gap-3">
              {days.map(d => (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-36 w-full items-end justify-center gap-1">
                    <div className="w-1/3 max-w-4 rounded-t bg-accent" style={{ height: (d.conversations / max) * 100 + '%' }} title={'会话 ' + d.conversations} />
                    <div className="w-1/3 max-w-4 rounded-t bg-border" style={{ height: (d.visitors / max) * 100 + '%' }} title={'访客 ' + d.visitors} />
                  </div>
                  <div className="text-[11px] text-faint">{d.date}</div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>团队成员</CardHeader>
          <CardBody className="space-y-3">
            {users.map(u => (
              <div key={u.id} className="flex items-center gap-3">
                <Avatar name={u.name} online={!!u.online} size="sm" />
                <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5">{u.name}{u.role === 'admin' && <Badge>管理员</Badge>}</div><div className="truncate text-xs text-faint">{u.email}</div></div>
                <span className={u.online ? 'text-xs text-ok' : 'text-xs text-faint'}>{u.online ? '在线' : '离线'}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader>接入指引</CardHeader>
        <CardBody>
          <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
            <li>在 <a href="#/sites">站点管理</a> 创建站点，复制嵌入代码，放到网站页面的 &lt;/body&gt; 前（Xboard：后台 → 主题配置 → 自定义页脚 HTML）。</li>
            <li>在 <a href="#/settings">系统设置</a> 填入 AI 接口和 Key，即可使用 AI 自动接待、回复建议、润色翻译和会话总结。</li>
            <li>在 <a href="#/agents">客服成员</a> 添加同事账号，在 <a href="#/team">团队协作</a> 里建立私人群组、私信沟通；群聊里 @AI 可以召唤 AI 助手。</li>
          </ol>
        </CardBody>
      </Card>
    </div>
  )
}
