import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { Avatar } from '@/components/common'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { reloadUsers } from '@/lib/live'
import type { Row } from '@/lib/types'

export default function Agents() {
  const me = useStore(s => s.user)!
  const [list, setList] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const load = async () => setList(await api('GET', '/api/users'))
  React.useEffect(() => { load().catch(e => toast.error(errMsg(e))) }, [])
  const save = async () => {
    try {
      if (cur!.id) await api('PUT', '/api/users/' + cur!.id, { name: cur!.name, role: cur!.role, disabled: !!cur!.disabled, password: cur!.password })
      else await api('POST', '/api/users', cur)
      setCur(null); load(); reloadUsers(); toast.success('已保存')
    } catch (e) { toast.error(errMsg(e)) }
  }
  const del = async (u: Row) => { if (!confirm('删除成员 ' + u.name + '？')) return; try { await api('DELETE', '/api/users/' + u.id); load() } catch (e) { toast.error(errMsg(e)) } }
  return (
    <Card>
      <CardHeader>客服成员<span className="flex-1" /><Button onClick={() => setCur({ email: '', name: '', password: '', role: 'agent' })}><Plus />添加成员</Button></CardHeader>
      <Table>
        <thead><tr><Th>成员</Th><Th>角色</Th><Th>状态</Th><Th>最后在线</Th><Th /></tr></thead>
        <tbody>{list.map(u => (
          <Tr key={u.id}>
            <Td><div className="flex items-center gap-2.5"><Avatar name={u.name} online={!!u.online} size="sm" /><div>{u.name}<div className="text-xs text-faint">{u.email}</div></div></div></Td>
            <Td><Badge tone={u.role === 'admin' ? 'accent' : 'default'}>{u.role === 'admin' ? '管理员' : '客服'}</Badge></Td>
            <Td>{u.disabled ? <Badge tone="bad">已停用</Badge> : <span className="text-xs">{u.online ? '在线' : '离线'}</span>}</Td>
            <Td className="text-xs">{fmtTime(u.last_seen)}</Td>
            <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => setCur({ ...u, password: '' })}>编辑</Button> {u.id !== me.id && <Button size="xs" variant="danger" onClick={() => del(u)}>删除</Button>}</Td>
          </Tr>
        ))}</tbody>
      </Table>
      {cur && (
        <Modal title={cur.id ? '编辑成员' : '添加成员'} onClose={() => setCur(null)} footer={<><Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={save}>保存</Button></>}>
          <Field label="邮箱"><Input value={cur.email} disabled={!!cur.id} onChange={e => setCur({ ...cur, email: e.target.value })} /></Field>
          <Field label="名称"><Input value={cur.name} onChange={e => setCur({ ...cur, name: e.target.value })} /></Field>
          <Field label={cur.id ? '重置密码（留空不修改）' : '密码'}><Input value={cur.password} placeholder="至少 8 位" onChange={e => setCur({ ...cur, password: e.target.value })} /></Field>
          {cur.id !== me.id && <Field label="角色"><NativeSelect value={cur.role} onChange={e => setCur({ ...cur, role: e.target.value })}><option value="agent">客服</option><option value="admin">管理员</option></NativeSelect></Field>}
          {cur.id && cur.id !== me.id && <label className="flex items-center gap-3 text-sm">停用账号 <Switch checked={!!cur.disabled} onCheckedChange={v => setCur({ ...cur, disabled: v ? 1 : 0 })} /></label>}
        </Modal>
      )}
    </Card>
  )
}
