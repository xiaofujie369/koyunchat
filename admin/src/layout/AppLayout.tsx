import * as React from 'react'
import { NavLink, useLocation } from 'react-router'
import { Blocks, Clock, Globe, LayoutDashboard, LogOut, Menu, MessageCircle, MessagesSquare, Monitor, Radio, Settings, User, Users, Zap } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Avatar } from '@/components/common'
import { cn } from '@/lib/utils'

const NAV = [
  { grp: '接待' },
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/visitors', label: '实时访客', icon: Radio, count: 'live' },
  { to: '/inbox', label: '会话', icon: MessagesSquare, count: 'conv' },
  { to: '/history', label: '访客记录', icon: Clock },
  { grp: '办公' },
  { to: '/team', label: '团队协作', icon: Users, count: 'team' },
  { to: '/community', label: '社区群聊', icon: Globe },
  { to: '/canned', label: '快捷回复', icon: Zap },
  { grp: '管理', admin: true },
  { to: '/sites', label: '站点管理', icon: Monitor, admin: true },
  { to: '/agents', label: '客服成员', icon: User, admin: true },
  { to: '/plugins', label: '插件管理', icon: Blocks, admin: true },
  { to: '/settings', label: '系统设置', icon: Settings, admin: true },
] as const

export const TITLES: Record<string, string> = {
  dashboard: '仪表盘', visitors: '实时访客', inbox: '会话', history: '访客记录', team: '团队协作', community: '社区群聊',
  canned: '快捷回复', sites: '站点管理', agents: '客服成员', plugins: '插件管理', settings: '系统设置', profile: '个人设置',
}

export default function AppLayout({ children, flush }: { children: React.ReactNode; flush: boolean }) {
  const { user, wsOn, live, convs, channels, logout } = useStore()
  const [open, setOpen] = React.useState(false)
  const loc = useLocation()
  React.useEffect(() => setOpen(false), [loc.pathname])
  const page = loc.pathname.split('/')[1] || 'dashboard'
  const counts: Record<string, number> = {
    live: Object.keys(live).length,
    conv: convs.reduce((a, c) => a + (c.unread || 0), 0),
    team: channels.reduce((a, c) => a + (c.unread || 0), 0),
  }
  const isAdmin = user?.role === 'admin'
  return (
    <div className="flex h-full">
      {open && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={cn('fixed inset-y-0 left-0 z-40 flex w-[220px] flex-col border-r bg-sidebar px-3 py-4 transition-transform md:static md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="mb-4 flex items-center gap-2.5 px-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-white"><MessageCircle className="size-[18px]" /></span>
          <div className="leading-tight"><div className="text-[15px] font-bold">Koyun Chat</div><div className="text-[11.5px] text-faint">客服工作台</div></div>
        </div>
        <nav className="flex-1 overflow-y-auto">
          {NAV.map((n, i) => {
            if ('admin' in n && n.admin && !isAdmin) return null
            if ('grp' in n) return <div key={i} className="mt-3 mb-1 px-2.5 text-[11.5px] font-medium text-faint">{n.grp}</div>
            const Icon = n.icon, c = 'count' in n ? counts[n.count] : 0
            return (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cn('mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-muted-foreground no-underline hover:bg-sidebar-hover',
                isActive && 'bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,.05)]')}>
                <Icon className="size-4" /><span className="flex-1">{n.label}</span>
                {c > 0 && <span className={cn('rounded-full px-1.5 text-[11px] leading-[18px] font-semibold', 'count' in n && n.count === 'live' ? 'bg-muted text-muted-foreground' : 'bg-bad text-white')}>{c}</span>}
              </NavLink>
            )
          })}
        </nav>
        <div className="mt-2 flex items-center gap-2.5 border-t px-1.5 pt-3">
          <Avatar name={user?.name} online={wsOn} size="sm" />
          <NavLink to="/profile" className="min-w-0 flex-1 truncate text-[13px] text-foreground no-underline hover:underline">{user?.name}</NavLink>
          <button title="退出登录" onClick={logout} className="cursor-pointer rounded-md p-1.5 text-faint hover:bg-sidebar-hover hover:text-foreground"><LogOut className="size-4" /></button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur md:px-6">
          <button className="cursor-pointer rounded-md p-1.5 hover:bg-muted md:hidden" onClick={() => setOpen(true)}><Menu className="size-5" /></button>
          <h1 className="flex-1 text-lg font-bold">{TITLES[page] || '仪表盘'}</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground border">
            <span className={cn('size-2 rounded-full', wsOn ? 'bg-ok' : 'bg-warn animate-pulse')} />{wsOn ? '已连接' : '连接中…'}
          </span>
        </header>
        {flush ? children : <main className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-[1280px] p-4 md:p-6">{children}</div></main>}
      </div>
    </div>
  )
}
