import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardHeader, Empty } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { Table, Td, Th, Tr } from '@/components/ui/table'
import { useStore } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import type { Row } from '@/lib/types'

export default function Canned() {
  const canned = useStore(s => s.canned)
  const [cur, setCur] = React.useState<Row | null>(null)
  const load = async () => useStore.getState().set({ canned: await api('GET', '/api/canned') })
  const save = async () => {
    try { if (cur!.id) await api('PUT', '/api/canned/' + cur!.id, cur); else await api('POST', '/api/canned', cur); setCur(null); load(); toast.success('已保存') } catch (e) { toast.error(errMsg(e)) }
  }
  const del = async (c: Row) => { if (!confirm('删除 /' + c.shortcut + '？')) return; try { await api('DELETE', '/api/canned/' + c.id); load() } catch (e) { toast.error(errMsg(e)) } }
  return (
    <Card>
      <CardHeader>快捷回复<span className="text-xs font-normal text-muted-foreground">在回复框输入 / 调出，支持 {'{name}'} {'{email}'} 变量</span><span className="flex-1" />
        <Button onClick={() => setCur({ shortcut: '', body: '' })}><Plus />新增</Button></CardHeader>
      <Table>
        <thead><tr><Th className="w-40">快捷词</Th><Th>内容</Th><Th className="w-32" /></tr></thead>
        <tbody>{canned.map(c => (
          <Tr key={c.id}><Td className="font-semibold">/{c.shortcut}</Td><Td className="whitespace-pre-wrap">{c.body}</Td>
            <Td className="whitespace-nowrap"><Button size="xs" variant="outline" onClick={() => setCur({ ...c })}>编辑</Button> <Button size="xs" variant="danger" onClick={() => del(c)}>删除</Button></Td></Tr>
        ))}</tbody>
      </Table>
      {!canned.length && <Empty>暂无快捷回复</Empty>}
      {cur && (
        <Modal title="快捷回复" onClose={() => setCur(null)} footer={<><Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={save}>保存</Button></>}>
          <Field label="快捷词"><Input value={cur.shortcut} onChange={e => setCur({ ...cur, shortcut: e.target.value })} placeholder="例如 ios" /></Field>
          <Field label="内容"><Textarea className="min-h-36" value={cur.body} onChange={e => setCur({ ...cur, body: e.target.value })} /></Field>
        </Modal>
      )}
    </Card>
  )
}
