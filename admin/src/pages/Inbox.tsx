import * as React from 'react'
import { useParams } from 'react-router'
import { ArrowLeft, FileText, NotebookPen, Sparkles, Wand2, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Empty } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AttachmentView, Avatar, ChatLayout, EmojiButton, FileButtons, insertAt, pastedFile } from '@/components/common'
import VisitorPanel from '@/components/VisitorPanel'
import { ls, useStore, S } from '@/lib/store'
import { api, errMsg } from '@/lib/api'
import { fmtTime, rich, visitorName } from '@/lib/format'
import { go, loadConvs, wsSend } from '@/lib/live'
import { uploadFile } from '@/lib/upload'
import { cn } from '@/lib/utils'
import type { Attachment, Conv, Msg, Row } from '@/lib/types'

const TABS: [string, string][] = [['open', '进行中'], ['mine', '我的'], ['unassigned', '未分配'], ['closed', '已结束']]
const REWRITES: [string, string][] = [['polish', '润色'], ['shorter', '更简洁'], ['friendly', '更亲切'], ['en', '翻译为英文'], ['zh', '翻译为中文'], ['ja', '翻译为日文'], ['ru', '翻译为俄文'], ['fa', '翻译为波斯语']]

export default function Inbox() {
  const id = parseInt(useParams().id || '') || 0
  const { convs, sites, ai, peek, live, users, chatMsgs, canned } = useStore()
  const [q, setQ] = React.useState('')
  const [site, setSite] = React.useState('0')
  const [filter, setFilter] = React.useState('open')
  const [snapshot, setSnapshot] = React.useState<Conv[] | null>(null)
  const [conv, setConv] = React.useState<Conv | null>(null)
  const [visitor, setVisitor] = React.useState<Row | null>(null)

  const liveTab = filter === 'open' && site === '0' && !q
  const list = liveTab ? convs.filter(c => c.status === 'open') : snapshot || []
  const unreadTotal = convs.reduce((a, c) => a + (c.unread || 0), 0)
  const aiSite = (sid: number) => { const s = sites.find(x => x.id === sid); return ai && !!s && s.ai_mode !== 'off' }

  const load = React.useCallback(async (f = filter, s = site, qq = q) => {
    if (f === 'open' && s === '0' && !qq) { await loadConvs(); setSnapshot(null); return }
    try { setSnapshot(await api('GET', `/api/conversations?filter=${f}&site_id=${s}&q=${encodeURIComponent(qq)}`)) } catch (e) { toast.error(errMsg(e)) }
  }, [filter, site, q])

  // 打开会话
  React.useEffect(() => {
    S().set({ openConvId: id })
    if (!id) { setConv(null); setVisitor(null); S().set({ chatMsgs: [] }); return }
    let stop = false
    api('GET', '/api/conversations/' + id).then(r => {
      if (stop) return
      setConv(r.conversation); setVisitor(r.visitor); S().set({ chatMsgs: r.messages })
      if (r.conversation.unread) api('POST', '/api/conversations/' + id + '/read').catch(() => {})
    }).catch(e => toast.error(errMsg(e)))
    return () => { stop = true }
  }, [id])
  React.useEffect(() => () => S().set({ openConvId: 0 }), [])
  // 实时更新会话状态（转接、AI 开关、在线）
  React.useEffect(() => { if (conv) { const c = convs.find(x => x.id === conv.id); if (c) setConv(x => (x ? { ...x, ...c } : x)) } }, [convs]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (body: Row, msg?: string) => {
    try { const c = await api('POST', '/api/conversations/' + conv!.id + '/update', body); S().upsertConv(c); setConv(x => ({ ...x!, ...c })); if (msg) toast.success(msg); return c } catch (e) { toast.error(errMsg(e)) }
  }
  const setStatus = async (s: string) => {
    const c = await update({ status: s })
    if (!c) return
    if (s === 'closed') S().set(st => ({ convs: st.convs.filter(x => x.id !== c.id || x.status === 'open') }))
    const r = await api('GET', '/api/conversations/' + conv!.id); setConv(r.conversation); S().set({ chatMsgs: r.messages })
  }
  const reloadVisitor = async () => { if (conv) setVisitor(await api('GET', '/api/visitors/' + conv.visitor_id)) }
  const liveV = conv ? live[conv.visitor_id] : null

  const listPane = (
    <>
      <div className="flex gap-2 p-2.5 pb-0">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索访客 / 邮箱 / IP / 消息" onKeyDown={e => e.key === 'Enter' && load()} />
        <NativeSelect className="w-28" value={site} onChange={e => { setSite(e.target.value); load(filter, e.target.value) }}>
          <option value="0">全部站点</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </NativeSelect>
      </div>
      <div className="m-2.5 flex rounded-lg bg-muted p-0.5">
        {TABS.map(([k, t]) => (
          <button key={k} onClick={() => { setFilter(k); load(k) }} className={cn('flex-1 cursor-pointer rounded-md py-1 text-[13px]', filter === k ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground')}>
            {t}{k === 'open' && unreadTotal > 0 && <span className="ml-1 rounded-full bg-bad px-1.5 text-[11px] text-white">{unreadTotal}</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {list.map(c => (
          <button key={c.id} onClick={() => go('inbox/' + c.id)}
            className={cn('mb-0.5 flex w-full cursor-pointer gap-2.5 rounded-xl p-2.5 text-left', conv?.id === c.id ? 'bg-accent text-white' : 'hover:bg-muted')}>
            <Avatar name={visitorName(c)} seed={c.visitor_id} online={!!c.online} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="flex-1 truncate font-semibold">{visitorName(c)}</span><span className={cn('text-[11px]', conv?.id === c.id ? 'text-white/70' : 'text-faint')}>{fmtTime(c.last_at)}</span></div>
              <div className="flex items-center gap-2"><span className={cn('flex-1 truncate text-[13px]', conv?.id === c.id ? 'text-white/85' : 'text-muted-foreground')}>{peek[c.visitor_id] ? '正在输入：' + peek[c.visitor_id] : c.last_msg || '新会话'}</span>
                {c.unread > 0 && <span className="rounded-full bg-bad px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge>{c.site_name}</Badge>
                {c.assignee_name ? <Badge>{c.assignee_name}</Badge> : c.status === 'open' && <Badge tone="warn">未分配</Badge>}
                {c.status === 'open' && !c.ai_paused && aiSite(c.site_id) && <Badge tone="accent">AI 接待</Badge>}
                {c.rating > 0 && <Badge>{'★'.repeat(c.rating)}</Badge>}
              </div>
            </div>
          </button>
        ))}
        {!list.length && <Empty>暂无会话</Empty>}
      </div>
    </>
  )

  const chatPane = conv ? (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => go('inbox')}><ArrowLeft /></Button>
        <Avatar name={visitorName(conv)} seed={conv.visitor_id} online={!!conv.online} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate font-semibold">{visitorName(conv)} <Badge>{conv.site_name}</Badge></div>
          <div className="truncate text-xs text-faint">{liveV ? '正在浏览：' + (liveV.title || liveV.url) : '访客已离线'}</div>
        </div>
        {aiSite(conv.site_id) && conv.status === 'open' && (
          <label className="flex items-center gap-1.5 text-xs" title="开启后 AI 会自动回复访客；客服回复后自动暂停">AI 接待 <Switch checked={!conv.ai_paused} onCheckedChange={v => update({ ai_paused: !v })} /></label>
        )}
        <NativeSelect className="w-32" value={conv.assignee_id} onChange={e => update({ assignee_id: parseInt(e.target.value) }, '已转接')}>
          <option value={0}>未分配</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}{u.online ? '' : '（离线）'}</option>)}
        </NativeSelect>
        {conv.status === 'open' ? <Button size="sm" variant="outline" onClick={() => setStatus('closed')}>结束会话</Button> : <Button size="sm" variant="outline" onClick={() => setStatus('open')}>重新打开</Button>}
      </div>
      <Messages msgs={chatMsgs} />
      {peek[conv.visitor_id] && <div className="flex items-center gap-2 border-t bg-warn-soft px-4 py-1.5 text-xs text-warn"><NotebookPen className="size-3.5" />访客正在输入：{peek[conv.visitor_id]}</div>}
      <Composer conv={conv} visitor={{ ...visitor, ...(liveV || {}) }} ai={ai} canned={canned} />
    </>
  ) : <div className="grid flex-1 place-items-center text-sm text-faint">选择左侧会话开始接待</div>

  return <ChatLayout hasChat={!!conv} list={listPane} chat={chatPane}
    info={conv && visitor ? <VisitorPanel v={{ ...visitor, live: liveV || null }} conv={conv} onChanged={reloadVisitor} /> : undefined} />
}

function Messages({ msgs }: { msgs: Msg[] }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, [msgs.length])
  const who = (m: Msg) => ({ visitor: '访客', agent: m.sender_name, ai: 'AI · ' + (m.sender_name || 'AI'), note: m.sender_name || '系统' } as Record<string, string>)[m.sender_type] || ''
  return (
    <div ref={ref} className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
      {msgs.map(m => {
        if (m.sender_type === 'system') return <div key={m.id} className="self-center rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">{m.body}</div>
        const out = m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'note'
        return (
          <div key={m.id} className={cn('flex max-w-[78%] flex-col', out ? 'items-end self-end' : 'items-start self-start')}>
            <div className={cn('rounded-2xl px-3.5 py-2 text-[14px] break-words whitespace-pre-wrap',
              m.sender_type === 'agent' && 'rounded-br-md bg-bubble-agent text-white',
              m.sender_type === 'visitor' && 'rounded-bl-md bg-bubble-visitor',
              m.sender_type === 'ai' && 'rounded-br-md bg-bubble-ai',
              m.sender_type === 'note' && 'rounded-br-md border border-dashed border-warn/50 bg-bubble-note')}>
              {m.sender_type === 'note' && <span className="text-xs font-semibold text-warn">内部备注 · </span>}
              <span className="rich" dangerouslySetInnerHTML={{ __html: rich(m.body) }} />
              <AttachmentView a={m.attachment} />
            </div>
            <div className="mt-0.5 px-1 text-[11px] text-faint">{who(m)} · {fmtTime(m.created_at)}</div>
          </div>
        )
      })}
    </div>
  )
}

function Composer({ conv, visitor, ai, canned }: { conv: Conv; visitor: Row; ai: boolean; canned: Row[] }) {
  const ta = React.useRef<HTMLTextAreaElement>(null)
  const [text, setTextRaw] = React.useState('')
  const [mode, setMode] = React.useState<'reply' | 'note'>('reply')
  const [sending, setSending] = React.useState(false)
  const [cannedIdx, setCannedIdx] = React.useState(0)
  const [aiBox, setAiBox] = React.useState<{ text: string; title: string; kind: string } | null>(null)
  const [aiBusy, setAiBusy] = React.useState(false)
  const [rwOpen, setRwOpen] = React.useState(false)
  const typingAt = React.useRef(0)

  // 每个会话的草稿保存在浏览器
  React.useEffect(() => { setTextRaw(ls.get('kc_draft_' + conv.id)); setAiBox(null); ta.current?.focus() }, [conv.id])
  const setText = (v: string) => { setTextRaw(v); if (v) ls.set('kc_draft_' + conv.id, v); else ls.del('kc_draft_' + conv.id) }

  const cannedList = text.startsWith('/')
    ? canned.filter(c => { const k = text.slice(1).toLowerCase(); return c.shortcut.toLowerCase().includes(k) || c.body.toLowerCase().includes(k) }).slice(0, 8)
    : []
  const useCanned = (c: Row) => { setText(c.body.replace(/\{name\}/g, visitor.name || '').replace(/\{email\}/g, visitor.email || '')); ta.current?.focus() }

  const onInput = (v: string) => {
    setText(v); setCannedIdx(0)
    if (mode === 'reply' && Date.now() - typingAt.current > 2500) { typingAt.current = Date.now(); wsSend('typing', { conversation_id: conv.id, typing: true }) }
  }
  const send = async (att?: Attachment) => {
    const body = text.trim()
    if ((!body && !att) || sending) return
    setSending(true)
    try {
      const m = await api('POST', '/api/conversations/' + conv.id + '/messages', { body: att ? '' : body, attachment: att || null, note: mode === 'note' })
      S().set(st => ({ chatMsgs: st.chatMsgs.some(x => x.id === m.id) ? st.chatMsgs : [...st.chatMsgs, m] }))
      if (!att) { setText(''); wsSend('typing', { conversation_id: conv.id, typing: false }) }
    } catch (e) { toast.error(errMsg(e)) }
    setSending(false)
  }
  const sendFile = async (f: File) => { try { await send(await uploadFile(f)) } catch (e) { toast.error(errMsg(e)) } }
  const keydown = (e: React.KeyboardEvent) => {
    if (cannedList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCannedIdx(i => (i + 1) % cannedList.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCannedIdx(i => (i + cannedList.length - 1) % cannedList.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); useCanned(cannedList[cannedIdx]); return }
      if (e.key === 'Escape') { setText(''); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }
  const runAI = async (fn: () => Promise<void>) => { setAiBusy(true); try { await fn() } catch (e) { toast.error(errMsg(e)) } setAiBusy(false) }
  const suggest = () => runAI(async () => {
    const r = await api('POST', '/api/ai/suggest', { conversation_id: conv.id, hint: text.startsWith('/') ? '' : text })
    setAiBox({ text: r.text, title: 'AI 建议回复', kind: 'suggest' })
  })
  const summarize = () => runAI(async () => { const r = await api('POST', '/api/ai/summarize', { conversation_id: conv.id }); setAiBox({ text: r.text, title: '会话总结', kind: 'summary' }) })
  const rewrite = (m: string) => {
    setRwOpen(false)
    if (!text.trim()) return toast.error('请先在输入框写内容')
    runAI(async () => { const r = await api('POST', '/api/ai/rewrite', { text, mode: m }); setText(r.text) })
  }

  return (
    <>
      {aiBox && (
        <div className="mx-4 mb-2 max-h-48 overflow-y-auto rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-[13px] whitespace-pre-wrap">
          <div className="mb-1.5 flex items-center gap-2 font-semibold text-accent"><Sparkles className="size-4" />{aiBox.title}<span className="flex-1" />
            {aiBox.kind === 'suggest' && <Button size="xs" variant="outline" onClick={() => { setText(aiBox.text); setAiBox(null); ta.current?.focus() }}>使用</Button>}
            <Button size="xs" variant="ghost" onClick={() => setAiBox(null)}><X /></Button></div>
          {aiBox.text}
        </div>
      )}
      <div className={cn('relative border-t bg-card', mode === 'note' && 'bg-bubble-note')}>
        {cannedList.length > 0 && (
          <div className="absolute bottom-full left-3 mb-1 w-[380px] max-w-[90vw] rounded-xl border bg-card p-1 shadow-xl">
            {cannedList.map((c, i) => (
              <button key={c.id} onMouseDown={e => { e.preventDefault(); useCanned(c) }} className={cn('block w-full cursor-pointer truncate rounded-lg px-2.5 py-1.5 text-left text-[13px]', i === cannedIdx ? 'bg-accent-soft' : 'hover:bg-muted')}>
                <b>/{c.shortcut}</b> <span className="text-faint">{c.body.slice(0, 60)}</span></button>
            ))}
          </div>
        )}
        <textarea ref={ta} value={text} onChange={e => onInput(e.target.value)} onKeyDown={keydown}
          onPaste={e => { const f = pastedFile(e); if (f) { e.preventDefault(); sendFile(f) } }}
          placeholder={mode === 'note' ? '内部备注，访客看不到…' : '输入回复，Enter 发送，Shift+Enter 换行，/ 快捷回复'}
          className="block h-24 w-full resize-none bg-transparent px-4 pt-3 text-[14px] outline-none placeholder:text-faint" />
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
          <div className="mr-1 flex rounded-lg bg-muted p-0.5 text-xs">
            {(['reply', 'note'] as const).map(m => <button key={m} onClick={() => setMode(m)} className={cn('cursor-pointer rounded-md px-2.5 py-1', mode === m ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground')}>{m === 'reply' ? '回复' : '备注'}</button>)}
          </div>
          <EmojiButton onPick={e => setText(insertAt(ta.current, text, e))} />
          <FileButtons onFile={sendFile} />
          <Button variant="ghost" size="icon" title="快捷回复" onClick={() => { setText('/'); ta.current?.focus() }}><Zap /></Button>
          {ai && <>
            <Button variant="ghost" size="sm" disabled={aiBusy} onClick={suggest} title="AI 根据对话和知识库起草回复（可先在输入框写要点）"><Sparkles />AI 建议</Button>
            <Popover open={rwOpen} onOpenChange={setRwOpen}>
              <PopoverTrigger asChild><Button variant="ghost" size="sm" disabled={aiBusy}><Wand2 />润色/翻译</Button></PopoverTrigger>
              <PopoverContent side="top" className="w-40">
                {REWRITES.map(([k, t]) => <button key={k} onClick={() => rewrite(k)} className="block w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-muted">{t}</button>)}
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="sm" disabled={aiBusy} onClick={summarize}><FileText />总结</Button>
            {aiBusy && <span className="text-xs text-faint">AI 思考中…</span>}
          </>}
          <span className="flex-1" />
          <Button size="sm" variant="accent" onClick={() => send()} disabled={sending}>发送</Button>
        </div>
      </div>
    </>
  )
}
