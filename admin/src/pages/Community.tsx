import * as React from 'react'
import { useParams } from 'react-router'
import { ArrowLeft, Hash, Lock, MoreHorizontal, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Modal } from '@/components/ui/dialog'
import { AttachmentView, Avatar, ChatLayout, EmojiButton, FileButtons, insertAt, pastedFile } from '@/components/common'
import { useStore, S } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { copyText, fmtTime, parseExt, rich } from '@/lib/format'
import { go, loadRooms } from '@/lib/live'
import { uploadFile } from '@/lib/upload'
import { cn } from '@/lib/utils'
import type { Attachment, Room, Row } from '@/lib/types'

const ROOM_DEFAULT = { name: '', description: '', kind: 'public', color: '#7c6bd6', slow_mode: 0, sort: 0, member_invite: 1, readonly: 0, tg_chat_id: '' }

export default function Community() {
  const id = parseInt(useParams().id || '') || 0
  const { rooms, community, roomMsgs, user } = useStore()
  const isAdmin = user?.role === 'admin'
  const [members, setMembers] = React.useState<Row[]>([])
  const [cur, setCur] = React.useState<Row | null>(null)
  const [mod, setMod] = React.useState<{ id: number; name: string } | null>(null)
  const [cfg, setCfg] = React.useState<Row | null>(null)
  const [inviteURL, setInviteURL] = React.useState('')
  const [reply, setReply] = React.useState<Row | null>(null)
  const room = rooms.find(r => r.id === id) || null
  const tg: Row = community.tg || {}
  const tgChats: Row[] = (tg.chats || []).filter((c: Row) => c.id !== tg.support_chat_id)

  React.useEffect(() => { if (!rooms.length) loadRooms() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const loadMembers = React.useCallback(async () => { if (id) setMembers(await api('GET', '/api/community/rooms/' + id + '/members')) }, [id])
  React.useEffect(() => {
    S().set({ openRoomId: id }); setReply(null)
    if (!id) { S().set({ roomMsgs: [] }); return }
    api('GET', '/api/community/rooms/' + id + '/messages').then(m => S().set({ roomMsgs: m })).catch(e => toast.error(errMsg(e)))
    loadMembers().catch(() => {})
  }, [id, loadMembers])
  React.useEffect(() => () => S().set({ openRoomId: 0 }), [])

  const run = async (fn: () => Promise<void>) => { try { await fn() } catch (e) { toast.error(errMsg(e)) } }
  const pin = (mid: number) => run(async () => { await api('POST', '/api/community/rooms/' + id + '/pin', { message_id: mid }); await loadRooms() })
  const del = (m: Row) => confirm('删除这条消息？') && run(() => api('DELETE', '/api/community/messages/' + m.id))
  const act = (action: string, minutes = 0) => run(async () => {
    await api('POST', '/api/community/rooms/' + id + '/moderate', { member_id: mod!.id, action, minutes })
    toast.success('已处理'); setMod(null); loadMembers(); loadRooms()
  })
  const globalBan = (b: boolean) => (!b || confirm('封禁后该用户无法在任何群组发言，确定？')) && run(async () => {
    await api('POST', '/api/community/members/' + mod!.id + '/ban', { banned: b }); toast.success('已处理'); setMod(null); loadMembers()
  })
  const saveRoom = () => run(async () => {
    const c = cur!, body = { name: c.name, description: c.description, kind: c.kind, color: c.color, slow_mode: Number(c.slow_mode) || 0, sort: Number(c.sort) || 0, member_invite: c.member_invite ? 1 : 0, readonly: c.readonly ? 1 : 0, tg_chat_id: c.tg_chat_id || '' }
    if (c.id) await api('PUT', '/api/community/rooms/' + c.id, body)
    else { const r = await api('POST', '/api/community/rooms', body); go('community/' + r.id) }
    setCur(null); await loadRooms(); toast.success('已保存')
  })
  const removeRoom = () => {
    if (prompt('删除群组会清空所有消息。输入群组名称确认：') !== cur!.name) return
    run(async () => { await api('DELETE', '/api/community/rooms/' + cur!.id); setCur(null); await loadRooms(); go('community') })
  }
  const up = (k: string, v: unknown) => setCur(c => ({ ...c!, [k]: v }))

  const listPane = (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b px-4 py-3 text-[13px]">
        <div className="flex items-center gap-2"><span className={cn('size-2 rounded-full', community.enabled ? 'bg-ok' : 'bg-faint')} /><b className="flex-1">{community.enabled ? '社区已开放' : '社区未开放'}</b>
          {isAdmin && <Button size="xs" variant="outline" onClick={() => setCfg({ community_enabled: community.enabled ? '1' : '0', community_xboard_url: community.xboard_url || '', community_url: '', brand_name: '' })}>设置</Button>}</div>
        {community.url && <a href={community.url} target="_blank" rel="noopener" className="mt-1 block truncate text-xs">{community.url}</a>}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mt-1 mb-1 flex items-center px-3 text-[11.5px] font-medium text-faint">群组<span className="flex-1" />{isAdmin && <button onClick={() => setCur({ ...ROOM_DEFAULT })} title="新建群组" className="cursor-pointer rounded p-0.5 hover:bg-muted"><Plus className="size-3.5" /></button>}</div>
        {rooms.map(r => (
          <button key={r.id} onClick={() => go('community/' + r.id)} className={cn('mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13.5px]', room?.id === r.id ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-muted')}>
            {r.kind === 'public' ? <Hash className="size-4 text-faint" /> : <Lock className="size-4 text-faint" />}<span className="flex-1 truncate">{r.name}</span>
            {r.tg_chat_id && <Badge tone="tg">TG</Badge>}<span className="text-xs text-faint">{r.member_count}</span>
          </button>
        ))}
        {!rooms.length && <div className="px-3 py-2 text-xs text-faint">还没有群组，点右侧 + 创建</div>}
      </div>
    </div>
  )

  const chatPane = room ? (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => go('community')}><ArrowLeft /></Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold">{room.name}{!!room.readonly && <Badge>公告频道</Badge>}{!!room.slow_mode && <Badge>慢速 {room.slow_mode}s</Badge>}</div>
          <div className="truncate text-xs text-faint">{room.member_count} 位成员 · {room.description}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => run(async () => setInviteURL((await api('POST', '/api/community/rooms/' + room.id + '/invite')).url))}>邀请链接</Button>
        {isAdmin && <Button size="sm" variant="outline" onClick={() => setCur({ ...ROOM_DEFAULT, ...room })}>群设置</Button>}
      </div>
      {room.pinned && !room.pinned.deleted && (
        <div className="flex items-center gap-2 border-b bg-card-soft px-4 py-1.5 text-xs"><b className="text-accent">置顶</b><span className="flex-1 truncate">{room.pinned.body}</span><button className="cursor-pointer text-accent" onClick={() => pin(0)}>取消置顶</button></div>
      )}
      <RoomMessages room={room} msgs={roomMsgs} onReply={setReply} onPin={pin} onDel={del} onMod={(mid, name) => setMod({ id: mid, name })} />
      <RoomComposer room={room} reply={reply} setReply={setReply} />
    </>
  ) : <div className="grid flex-1 place-items-center text-sm text-faint">选择左侧群组</div>

  const infoPane = room ? (
    <div className="p-4">
      <h4 className="mb-3 text-xs font-semibold text-muted-foreground">成员（{members.length}）</h4>
      <div className="space-y-2.5">
        {members.map(m => {
          const ext = parseExt(m.ext)
          return (
            <div key={m.id} className="flex items-start gap-2.5">
              <Avatar name={m.name} seed={'member' + m.id} online={!!m.online} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 truncate text-[13px]">{m.name}{!!m.banned && <Badge tone="bad">封禁</Badge>}{m.muted_until > Date.now() && <Badge tone="warn">禁言中</Badge>}</div>
                <div className="truncate text-xs text-faint">{m.email}</div>
                {ext.plan && <div className="truncate text-xs text-faint">{ext.plan} · {ext.expired_at}</div>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => setMod({ id: m.id, name: m.name })}><MoreHorizontal /></Button>
            </div>
          )
        })}
      </div>
    </div>
  ) : undefined

  return (
    <>
      <ChatLayout hasChat={!!room} list={listPane} chat={chatPane} info={infoPane} />
      {cur && (
        <Modal title={cur.id ? '群组设置' : '新建群组'} onClose={() => setCur(null)}
          footer={<>{cur.id && <Button variant="danger" className="mr-auto" onClick={removeRoom}>删除群组</Button>}<Button variant="outline" onClick={() => setCur(null)}>取消</Button><Button onClick={saveRoom}>保存</Button></>}>
          <Field label="名称"><Input maxLength={40} value={cur.name} onChange={e => up('name', e.target.value)} /></Field>
          <Field label="简介"><Input value={cur.description} onChange={e => up('description', e.target.value)} /></Field>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="类型"><NativeSelect value={cur.kind} onChange={e => up('kind', e.target.value)}><option value="public">公开（所有人可见可加入）</option><option value="private">私密（凭邀请链接加入）</option></NativeSelect></Field>
            <Field label="颜色"><div className="flex gap-2"><input type="color" value={cur.color} onChange={e => up('color', e.target.value)} className="h-9 w-11 cursor-pointer rounded border-0 bg-transparent" /><Input value={cur.color} onChange={e => up('color', e.target.value)} /></div></Field>
            <Field label="慢速模式（秒，0 关闭）"><Input type="number" min={0} value={cur.slow_mode} onChange={e => up('slow_mode', e.target.value)} /></Field>
            <Field label="排序（越大越靠前）"><Input type="number" value={cur.sort} onChange={e => up('sort', e.target.value)} /></Field>
          </div>
          <label className="mb-3 flex items-center gap-3 text-sm">允许成员邀请好友 <Switch checked={!!cur.member_invite} onCheckedChange={v => up('member_invite', v ? 1 : 0)} /></label>
          <label className="mb-4 flex items-center gap-3 text-sm">公告频道（仅官方可发言） <Switch checked={!!cur.readonly} onCheckedChange={v => up('readonly', v ? 1 : 0)} /></label>
          <Field label="互通 Telegram 群组" hint={!tg.running ? '先在 系统设置 → Telegram 互通 配置机器人，并把机器人拉进群' : undefined}>
            <NativeSelect value={cur.tg_chat_id || ''} onChange={e => up('tg_chat_id', e.target.value)}><option value="">不互通</option>{tgChats.map(c => <option key={c.id} value={c.id}>{c.title}（{c.id}）</option>)}</NativeSelect>
          </Field>
        </Modal>
      )}
      {mod && (
        <Modal title={'处理成员：' + mod.name} onClose={() => setMod(null)}>
          <div className="flex flex-wrap gap-2">
            {([[10, '禁言 10 分钟'], [60, '禁言 1 小时'], [1440, '禁言 1 天'], [10080, '禁言 7 天']] as [number, string][]).map(([m, t]) => <Button key={m} variant="outline" onClick={() => act('mute', m)}>{t}</Button>)}
            <Button variant="outline" onClick={() => act('mute', 0)}>解除禁言</Button>
            <Button variant="danger" onClick={() => act('kick')}>移出群组</Button>
            <Button variant="danger" onClick={() => act('ban')}>移出并禁止再加入</Button>
            <Button variant="danger" onClick={() => globalBan(true)}>封禁账号（全部群组）</Button>
            <Button variant="outline" onClick={() => globalBan(false)}>解除账号封禁</Button>
          </div>
        </Modal>
      )}
      {cfg && (
        <Modal title="社区设置" onClose={() => setCfg(null)} footer={<><Button variant="outline" onClick={() => setCfg(null)}>取消</Button><Button onClick={() => run(async () => { await api('PUT', '/api/community/settings', cfg); setCfg(null); await loadRooms(); toast.success('已保存') })}>保存</Button></>}>
          <Field hint="开启后，访客挂件会出现「群聊」按钮，已登录 Xboard 的用户点一下就能进入">
            <label className="flex items-center gap-3 text-sm font-medium">开放社区 <Switch checked={cfg.community_enabled === '1'} onCheckedChange={v => setCfg({ ...cfg, community_enabled: v ? '1' : '0' })} /></label></Field>
          <Field label="账户系统地址（Xboard）" hint="直接打开社区页面时，用这个 Xboard 校验邮箱和密码"><Input value={cfg.community_xboard_url} onChange={e => setCfg({ ...cfg, community_xboard_url: e.target.value })} placeholder="https://your-xboard.example.com" /></Field>
          <Field label="社区名称"><Input value={cfg.brand_name} onChange={e => setCfg({ ...cfg, brand_name: e.target.value })} placeholder="Koyun 社区" /></Field>
          <Field label="社区地址（可选）" hint="绑定其他域名（例如未被污染的域名）后可以填在这里"><Input value={cfg.community_url} onChange={e => setCfg({ ...cfg, community_url: e.target.value })} placeholder="留空 = 默认地址" /></Field>
        </Modal>
      )}
      {inviteURL && (
        <Modal title="邀请链接" onClose={() => setInviteURL('')} footer={<Button onClick={() => copyText(inviteURL).then(() => toast.success('已复制'))}>复制</Button>}>
          <pre className="rounded-lg bg-[#1f1d1a] px-3 py-2.5 font-mono text-xs break-all whitespace-pre-wrap text-[#e9e6df]">{inviteURL}</pre>
          <p className="mt-2 text-xs text-faint">7 天内有效，最多 50 人使用</p>
        </Modal>
      )}
    </>
  )
}

function RoomMessages({ room, msgs, onReply, onPin, onDel, onMod }: { room: Room; msgs: Row[]; onReply: (m: Row) => void; onPin: (id: number) => void; onDel: (m: Row) => void; onMod: (id: number, name: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const loadingOld = React.useRef(false)
  React.useEffect(() => { const el = ref.current; if (el && !loadingOld.current) el.scrollTop = el.scrollHeight }, [msgs.length])
  const onScroll = async () => {
    const el = ref.current!
    if (el.scrollTop > 40 || loadingOld.current || msgs.length < 60) return
    loadingOld.current = true; const h = el.scrollHeight
    try {
      const old: Row[] = await api('GET', '/api/community/rooms/' + room.id + '/messages?before=' + msgs[0].id)
      if (old.length) { S().set(st => ({ roomMsgs: [...old, ...st.roomMsgs] })); requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - h }) }
    } catch { /* 忽略 */ }
    setTimeout(() => { loadingOld.current = false }, 300)
  }
  const act = 'cursor-pointer text-[11px] text-faint hover:text-accent'
  return (
    <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4">
      {msgs.map(m => m.sender_kind === 'system'
        ? <div key={m.id} className="my-2 text-center text-xs text-faint">{m.body} · {fmtTime(m.created_at)}</div>
        : (
          <div key={m.id} className="group mt-3 flex gap-2.5">
            <Avatar name={m.sender_name} seed={m.sender_kind + m.sender_id} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">{m.sender_name}
                {m.sender_kind === 'staff' && <Badge tone="warn">官方</Badge>}{m.sender_kind === 'tg' && <Badge tone="tg">TG</Badge>}
                <span className="text-[11px] font-normal text-faint">{fmtTime(m.created_at)}</span>
                {!m.deleted && <span className="ml-1 hidden gap-2 font-normal group-hover:inline-flex">
                  <button className={act} onClick={() => onReply(m)}>回复</button><button className={act} onClick={() => onPin(m.id)}>置顶</button>
                  <button className={cn(act, 'hover:text-bad')} onClick={() => onDel(m)}>删除</button>
                  {m.sender_kind === 'member' && <button className={cn(act, 'hover:text-bad')} onClick={() => onMod(m.sender_id, m.sender_name)}>处理</button>}</span>}
              </div>
              {m.reply && <div className="my-0.5 border-l-[3px] border-accent pl-1.5 text-xs text-faint">{m.reply.sender_name}：{m.reply.body}</div>}
              {m.deleted ? <div className="text-[13px] italic text-faint">消息已删除</div>
                : <div className="text-[14px] break-words whitespace-pre-wrap"><span className="rich" dangerouslySetInnerHTML={{ __html: rich(m.body) }} /><AttachmentView a={m.attachment} /></div>}
            </div>
          </div>
        ))}
      {!msgs.length && <div className="py-10 text-center text-sm text-faint">还没有消息</div>}
    </div>
  )
}

function RoomComposer({ room, reply, setReply }: { room: Room; reply: Row | null; setReply: (m: Row | null) => void }) {
  const ta = React.useRef<HTMLTextAreaElement>(null)
  const [text, setText] = React.useState('')
  const send = async (att?: Attachment) => {
    const body = att ? '' : text.trim()
    if (!body && !att) return
    try {
      const m = await api('POST', '/api/community/rooms/' + room.id + '/messages', { body, attachment: att || null, reply_to: reply ? reply.id : 0 })
      S().set(st => ({ roomMsgs: st.roomMsgs.some(x => x.id === m.id) ? st.roomMsgs : [...st.roomMsgs, m] }))
      if (!att) setText('')
      setReply(null)
    } catch (e) { toast.error(errMsg(e)) }
  }
  const sendFile = async (f: File) => { try { await send(await uploadFile(f)) } catch (e) { toast.error(errMsg(e)) } }
  return (
    <div className="border-t bg-card">
      {reply && <div className="flex items-center gap-2 px-4 pt-2 text-xs text-faint">回复 <b className="text-foreground">{reply.sender_name}</b>：<span className="flex-1 truncate">{(reply.body || '').slice(0, 60)}</span><button className="cursor-pointer" onClick={() => setReply(null)}><X className="size-3.5" /></button></div>}
      <textarea ref={ta} value={text} placeholder="以官方身份发言，Enter 发送" onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        onPaste={e => { const f = pastedFile(e); if (f) { e.preventDefault(); sendFile(f) } }}
        className="block h-20 w-full resize-none bg-transparent px-4 pt-3 text-[14px] outline-none placeholder:text-faint" />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        <EmojiButton onPick={e => setText(insertAt(ta.current, text, e))} />
        <FileButtons onFile={sendFile} />
        <span className="flex-1" />
        <Button size="sm" variant="accent" onClick={() => send()}>发送</Button>
      </div>
    </div>
  )
}
