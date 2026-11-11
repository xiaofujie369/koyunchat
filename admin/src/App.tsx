import * as React from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { Toaster } from 'sonner'
import { useStore } from '@/lib/store'
import { applyTheme, bootstrap, disconnectWS } from '@/lib/live'
import AppLayout from '@/layout/AppLayout'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import Visitors from '@/pages/Visitors'
import Inbox from '@/pages/Inbox'
import History from '@/pages/History'
import Team from '@/pages/Team'
import Community from '@/pages/Community'
import Canned from '@/pages/Canned'
import Sites from '@/pages/Sites'
import Agents from '@/pages/Agents'
import Plugins from '@/pages/Plugins'
import Settings from '@/pages/Settings'
import Profile from '@/pages/Profile'

const FLUSH = ['inbox', 'team', 'community'] // 这几页是全屏聊天布局

export default function App() {
  const token = useStore(s => s.token), user = useStore(s => s.user), theme = useStore(s => s.theme)
  const loc = useLocation()
  React.useEffect(() => { applyTheme() }, [theme])
  React.useEffect(() => {
    if (token && !user) bootstrap().catch(e => console.error(e))
    if (!token) disconnectWS()
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const toaster = <Toaster position="top-center" richColors closeButton duration={2500} />
  if (!user) return <>{toaster}{token ? <div className="grid h-full place-items-center text-sm text-faint">加载中…</div> : <Login />}</>
  const page = loc.pathname.split('/')[1] || 'dashboard'
  const admin = user.role === 'admin'
  const adminOnly = (el: React.ReactNode) => (admin ? el : <Navigate to="/dashboard" replace />)
  return (
    <>
      {toaster}
      <AppLayout flush={FLUSH.includes(page)}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/visitors" element={<Visitors />} />
          <Route path="/inbox/:id?" element={<Inbox />} />
          <Route path="/history" element={<History />} />
          <Route path="/team/:id?" element={<Team />} />
          <Route path="/community/:id?" element={<Community />} />
          <Route path="/canned" element={<Canned />} />
          <Route path="/sites" element={<Sites />} />
          <Route path="/agents" element={adminOnly(<Agents />)} />
          <Route path="/plugins" element={adminOnly(<Plugins />)} />
          <Route path="/settings" element={adminOnly(<Settings />)} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AppLayout>
    </>
  )
}
