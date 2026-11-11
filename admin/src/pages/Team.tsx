import * as React from 'react'
import { useParams } from 'react-router'
import { ArrowLeft, Hash, Lock, Plus, Sparkles, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Hint, Input, NativeSelect } from '@/components/ui/input'
import { Modal } from '@/components/ui/dialog'
import { AttachmentView, Avatar, ChatLayout, EmojiButton, FileButtons, insertAt, pastedFile } from '@/components/common'
import { useStore, S } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime, rich } from '@/lib/format'
import { go, loadChannels, wsSend } from '@/lib/live'
import { uploadFile } from '@/lib/upload'
import { cn } from '@/lib/utils'
import type { Attachment, Channel, Row, TeamMsg } from '@/lib/types'

export default function Team() {
  const id = parseInt(useParams().id || '') || 0
  const { channels, joinable, users, user, teamMsgs, teamTyping, ai } = useStore()
  const me = user!
  const [ch, setCh] = React.useState<Channel | null>(null)
  const [create, setCreate] = React.useState<Row | null>(null)
  const [showMembers, setShowMembers] = React.useState(false)
  const others = users.filter(u => u.id !== me.id)

  const open = React.useCallback(async (cid: number) => {
    S().set({ openChannelId: cid })
    if (!cid) { setCh(null); S().set({ teamMsgs: [] }); return }
    try {
      const [c, msgs] = await Promise.all([api('GET', '/api/channels/' + cid), api('GET', '/api/channels/' + cid + '/messages')])
      if (S().openChannelId !== cid) return
      setCh(c); S().set(st => ({ teamMsgs: msgs, channels: st.channels.map(x => (x.id === cid ? { ...x, unread: 0 } : x)) }))
      api('POST', '/api/channels/' + cid + '/read').catch(() => {})
    } catch (e) { toast.error(errMsg(e)); go('team') }
  }, [])
  React.useEffect(() => { open(id) }, [id, open])
  React.useEffect(() => () => S().set({ openChannelId: 0 }), [])
  // 频道成员、名称有变化时同步
  React.useEffect(() => { if (ch) { const c = channels.find(x => x.id === ch.id); if (c) setCh(x => ({ ...x!, name: c.name, topic: c.topic, members: c.members || x!.members })) } }, [channels]) // eslint-disable-line react-hooks/exhaustive-deps

  const byKind = (k: string) => channels.filter(c => c.kind === k).sort((a, b) => (b.last_at || 0) - (a.last_at || 0))
  const dmUnread = (uid: number) => channels.find(c => c.kind === 'dm' && c.peer_id === uid)?.unread || 0
  const dmUser = async (uid: number) => { try { const c = await api('POST', '/api/channels/dm', { user_id: uid }); setShowMembers(false); await loadChannels(); go('team/' + c.id) } catch (e) { toast.error(errMsg(e)) } }
  const join = async (c: Channel) => { try { await api('POST', '/api/channels/' + c.id + '/members', {}); await loadChannels(); go('team/' + c.id) } catch (e) { toast.error(errMsg(e)) } }
  const doCreate = async () => { try { const c = await api('POST', '/api/channels', create); setCreate(null); await loadChannels(); go('team/' + c.id) } catch (e) { toast.error(errMsg(e)) } }

  const Item = ({ on, onClick, children, muted }: { on?: boolean; onClick: () => void; children: React.ReactNode; muted?: boolean }) => (
    <button onClick={onClick} className={cn('mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13.5px]', on ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-muted', muted && 'text-faint')}>{children}</button>
  )
  const Unread = ({ n }: { n?: number }) => (n ? <span className="ml-auto rounded-full bg-bad px-1.5 text-[11px] font-semibold text-white">{n}</span> : null)
  const Sec = ({ t, add }: { t: string; add?: () => void }) => (
    <div className="mt-3 mb-1 flex items-center px-3 text-[11.5px] font-medium text-faint">{t}<span className="flex-1" />{add && <button onClick={add} title="新建" className="cursor-pointer rounded p-0.5 hover:bg-muted"><Plus className="size-3.5" /></button>}</div>
  )
  const listPane = (
    <div className="flex-1 overflow-y-auto p-2">
      <Sec t="频道" add={() => setCreate({ kind: 'public', name: '', topic: '', members: [] })} />
      {byKind('public').map(c => <Item key={c.id} on={ch?.id === c.id} onClick={() => go('team/' + c.id)}><Hash className="size-4 text-faint" />{c.name}<Unread n={c.unread} /></Item>)}
      {joinable.map(c => <Item key={'j' + c.id} muted onClick={() => join(c)}><Hash className="size-4" />{c.name}<span className="ml-auto text-xs">加入</span></Item>)}
      <Sec t="私人群组" add={() => setCreate({ kind: 'private', name: '', topic: '', members: [] })} />
      {byKind('private').map(c => <Item key={c.id} on={ch?.id === c.id} onClick={() => go('team/' + c.id)}><Lock className="size-4 text-faint" />{c.name}<Unread n={c.unread} /></Item>)}
      {!byKind('private').length && <div className="px-3 py-1 text-xs text-faint">还没有群组，点右侧 + 创建</div>}
      <Sec t="私信" />
      {others.map(u => <Item key={'u' + u.id} on={ch?.kind === 'dm' && ch.peer_id === u.id} onClick={() => dmUser(u.id)}><Avatar name={u.name} online={!!u.online} size="sm" className="size-6 text-[11px]" />{u.name}<Unread n={dmUnread(u.id)} /></Item>)}
    </div>
  )

  const chatPane = ch ? (
    <>
      <div className="flex items-center gap-2.5 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => go('team')}><ArrowLeft /></Button>
        <div className="min-w-0 flex-1"><div className="font-semibold">{ch.name}</div><div className="truncate text-xs text-faint">{ch.kind === 'dm' ? '私信' : ch.topic || (ch.members?.length || 0) + ' 位成员'}</div></div>
        {ch.kind !== 'dm' && <Button size="sm" variant="outline" onClick={() => setShowMembers(true)}><Users />成员 {ch.members?.length || 0}</Button>}
      </div>
      <TeamMessages ch={ch} msgs={teamMsgs} />
      <div className="h-5 px-5 text-xs text-faint">{teamTyping[ch.id] ? teamTyping[ch.id] + ' 正在输入…' : ''}</div>
      <TeamComposer ch={ch} ai={ai} />
    </>
  ) : <div className="grid flex-1 place-items-center text-sm text-faint">选择左侧频道、群组或同事开始聊天</div>

  return (
    <>
      <ChatLayout hasChat={!!ch} list={listPane} chat={chatPane} />
      {create && (
        <Modal title={create.kind === 'public' ? '新建公开频道' : '新建私人群组'} onClose={() => setCreate(null)} footer={<><Button variant="outline" onClick={() => setCreate(null)}>取消</Button><Button onClick={doCreate}>创建</Button></>}>
          <Field label="名称"><Input maxLength={40} value={create.name} onChange={e => setCreate({ ...create, name: e.target.value })} /></Field>
          <Field label="简介"><Input value={create.topic} onChange={e => setCreate({ ...create, topic: e.target.value })} /></Field>
          {create.kind === 'private' ? (
            <Field label="成员" hint="私人群组只有成员可见，可随时邀请其他人。">
              {others.map(u => (
                <label key={u.id} className="mb-1.5 flex items-center gap-2 text-sm"><input type="checkbox" checked={create.members.includes(u.id)}
                  onChange={e => setCreate({ ...create, members: e.target.checked ? [...create.members, u.id] : create.members.filter((x: number) => x !== u.id) })} />{u.name} <span className="text-xs text-faint">{u.email}</span></label>
              ))}
            </Field>
          ) : <Hint>公开频道全员自动加入。</Hint>}
        </Modal>
      )}
      {showMembers && ch && <MembersModal ch={ch} setCh={setCh} onClose={() => setShowMembers(false)} dmUser={dmUser} />}
    </>
  )
}

function TeamMessages({ ch, msgs }: { ch: Channel; msgs: TeamMsg[] }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const loadingMore = React.useRef(false)
  React.useEffect(() => { const el = ref.current; if (el && !loadingMore.current) el.scrollTop = el.scrollHeight }, [msgs.length])
  const onScroll = async () => {
    const el = ref.current!
    if (el.scrollTop > 40 || loadingMore.current || !msgs.length) return
    loadingMore.current = true
    const h = el.scrollHeight
    try {
      const older: TeamMsg[] = await api('GET', '/api/channels/' + ch.id + '/messages?before=' + msgs[0].id)
      if (older.length) { S().set(st => ({ teamMsgs: [...older, ...st.teamMsgs] })); requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - h }) }
    } catch { /* 忽略 */ }
    setTimeout(() => { loadingMore.current = false }, 300)
  }
  const cont = (i: number) => { const a = msgs[i - 1], b = msgs[i]; return a && a.user_id === b.user_id && a.user_name === b.user_name && a.user_name !== '系统' && b.created_at - a.created_at < 5 * 60000 }
  return (
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4">
      {msgs.map((m, i) => m.user_id === 0 && m.user_name === '系统'
        ? <div key={m.id} className="my-2 text-center text-xs text-faint">{m.body} · {fmtTime(m.created_at)}</div>
        : (
          <div key={m.id} className={cn('flex gap-2.5', cont(i) ? 'mt-0.5' : 'mt-3')}>
            <div className="w-8 shrink-0">{!cont(i) && <Avatar name={m.user_name} seed={m.user_id || 'ai'} size="sm" />}</div>
            <div className="min-w-0 flex-1">
              {!cont(i) && <div className="flex items-center gap-1.5 text-[13px] font-semibold">{m.user_name}{m.user_id === 0 && <Badge tone="accent">AI</Badge>}<span className="text-[11px] font-normal text-faint">{fmtTime(m.created_at)}</span></div>}
              <div className="text-[14px] break-words whitespace-pre-wrap"><span className="rich" dangerouslySetInnerHTML={{ __html: rich(m.body) }} /><AttachmentView a={m.attachment} /></div>
            </div>
          </div>
        ))}
      {!msgs.length && <div className="py-10 text-center text-sm text-faint">还没有消息，打个招呼吧 👋</div>}
    </div>
  )
}

function TeamComposer({ ch, ai }: { ch: Channel; ai: boolean }) {
  const ta = React.useRef<HTMLTextAreaElement>(null)
  const [text, setText] = React.useState('')
  const typingAt = React.useRef(0)
  React.useEffect(() => { setText('') }, [ch.id])
  const send = async (att?: Attachment) => {
    const body = att ? '' : text.trim()
    if (!body && !att) return
    try {
      const m = await api('POST', '/api/channels/' + ch.id + '/messages', { body, attachment: att || null })
      S().set(st => ({ teamMsgs: st.teamMsgs.some(x => x.id === m.id) ? st.teamMsgs : [...st.teamMsgs, m] }))
      if (!att) setText('')
    } catch (e) { toast.error(errMsg(e)) }
  }
  const sendFile = async (f: File) => { try { await send(await uploadFile(f)) } catch (e) { toast.error(errMsg(e)) } }
  return (
    <div className="border-t bg-card">
      <textarea ref={ta} value={text} placeholder={'发送到 ' + ch.name + '，Enter 发送；@AI 召唤 AI 助手'}
        onChange={e => { setText(e.target.value); if (Date.now() - typingAt.current > 2500) { typingAt.current = Date.now(); wsSend('team_typing', { channel_id: ch.id }) } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        onPaste={e => { const f = pastedFile(e); if (f) { e.preventDefault(); sendFile(f) } }}
        className="block h-20 w-full resize-none bg-transparent px-4 pt-3 text-[14px] outline-none placeholder:text-faint" />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        <EmojiButton onPick={e => setText(insertAt(ta.current, text, e))} />
        <FileButtons onFile={sendFile} />
        {ai && <Button variant="ghost" size="sm" onClick={() => { setText(text + (text ? ' ' : '') + '@AI '); ta.current?.focus() }}><Sparkles />@AI</Button>}
        <span className="flex-1" />
        <Button size="sm" variant="accent" onClick={() => send()}>发送</Button>
      </div>
    </div>
  )
}

function MembersModal({ ch, setCh, onClose, dmUser }: { ch: Channel; setCh: (c: Channel) => void; onClose: () => void; dmUser: (id: number) => void }) {
  const { users, user } = useStore()
  const me = user!
  const [rename, setRename] = React.useState(ch.name)
  const [inviteId, setInviteId] = React.useState('')
  const canManage = ch.kind !== 'dm' && (ch.my_role === 'owner' || me.role === 'admin')
  const members = ch.members || []
  const invitable = users.filter(u => !members.some(m => m.id === u.id))
  const run = async (fn: () => Promise<void>) => { try { await fn() } catch (e) { toast.error(errMsg(e)) } }
  return (
    <Modal title="群组成员" onClose={onClose} footer={<>
      {canManage && <Button variant="danger" onClick={() => confirm('解散后所有消息将被删除，确定？') && run(async () => { await api('DELETE', '/api/channels/' + ch.id); onClose(); await loadChannels(); go('team') })}>解散群组</Button>}
      {ch.kind === 'private' && <Button variant="outline" onClick={() => confirm('确定退出该群组？') && run(async () => { await api('DELETE', '/api/channels/' + ch.id + '/members/' + me.id); onClose(); await loadChannels(); go('team') })}>退出群组</Button>}
      <Button onClick={onClose}>完成</Button></>}>
      {canManage && <Field label="群组名称"><div className="flex gap-2"><Input value={rename} onChange={e => setRename(e.target.value)} /><Button variant="outline" onClick={() => run(async () => { await api('PUT', '/api/channels/' + ch.id, { name: rename }); toast.success('已保存') })}>保存</Button></div></Field>}
      <div className="space-y-2">
        {members.map(m => (
          <div key={m.id} className="flex items-center gap-2.5">
            <Avatar name={m.name} online={!!m.online} size="sm" />
            <div className="flex-1">{m.name} {m.role === 'owner' && <Badge>群主</Badge>}</div>
            {m.id !== me.id && <Button size="xs" variant="outline" onClick={() => dmUser(m.id)}>私信</Button>}
            {canManage && m.id !== me.id && ch.kind === 'private' && <Button size="xs" variant="danger" onClick={() => confirm('移除 ' + m.name + '？') && run(async () => { await api('DELETE', '/api/channels/' + ch.id + '/members/' + m.id); setCh(await api('GET', '/api/channels/' + ch.id)) })}>移除</Button>}
          </div>
        ))}
      </div>
      {ch.kind === 'private' && invitable.length > 0 && (
        <Field label="邀请成员" className="mt-4">
          <div className="flex gap-2"><NativeSelect value={inviteId} onChange={e => setInviteId(e.target.value)}><option value="">选择同事</option>{invitable.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</NativeSelect>
            <Button onClick={() => inviteId && run(async () => { setCh(await api('POST', '/api/channels/' + ch.id + '/members', { user_ids: [parseInt(inviteId)] })); setInviteId('') })}>邀请</Button></div>
        </Field>
      )}
    </Modal>
  )
}
