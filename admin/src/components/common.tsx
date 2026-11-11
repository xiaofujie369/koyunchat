import * as React from 'react'
import { FileText, ImageIcon, Paperclip, Smile } from 'lucide-react'
import { colorOf, initial } from '@/lib/format'
import { EMOJI } from '@/lib/emoji'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Attachment } from '@/lib/types'

// 每秒刷新一次（停留时长等）
export function useTick(ms = 1000) {
  const [, set] = React.useState(0)
  React.useEffect(() => { const t = setInterval(() => set(x => x + 1), ms); return () => clearInterval(t) }, [ms])
}

export function Avatar({ name, seed, online, size = 'md', className }: { name?: string; seed?: unknown; online?: boolean; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <div
      className={cn('relative grid shrink-0 place-items-center rounded-full font-semibold text-white select-none',
        size === 'sm' && 'size-8 text-[13px]', size === 'md' && 'size-10 text-[15px]', size === 'lg' && 'size-14 text-xl', className)}
      style={{ background: colorOf(seed ?? name) }}
    >
      {initial(name)}
      {online !== undefined && (
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card', online ? 'bg-ok' : 'bg-faint')} />
      )}
    </div>
  )
}

export function AttachmentView({ a }: { a?: Attachment | null | '' }) {
  if (!a || !a.url) return null
  if ((a.type || '').startsWith('image/'))
    return <img src={a.url} alt={a.name || ''} onClick={() => window.open(a.url, '_blank')} className="mt-1 max-h-60 max-w-full cursor-zoom-in rounded-lg" />
  return (
    <a href={a.url} target="_blank" rel="noopener" className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-black/5 px-2.5 py-1.5 text-[13px] no-underline text-inherit">
      <FileText className="size-4" />{a.name || '文件'}
    </a>
  )
}

// 在光标处插入文字，返回新内容
export function insertAt(ta: HTMLTextAreaElement | null, value: string, text: string) {
  if (!ta) return value + text
  const s = ta.selectionStart ?? value.length, e = ta.selectionEnd ?? value.length
  const v = value.slice(0, s) + text + value.slice(e)
  requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length })
  return v
}

export function EmojiButton({ onPick }: { onPick: (e: string) => void }) {
  const [tab, setTab] = React.useState(0)
  return (
    <Popover>
      <PopoverTrigger asChild><Button variant="ghost" size="icon" title="表情"><Smile /></Button></PopoverTrigger>
      <PopoverContent side="top" className="w-[340px] p-2" onOpenAutoFocus={e => e.preventDefault()}>
        <div className="mb-1.5 flex gap-1 overflow-x-auto border-b pb-1.5">
          {EMOJI.map((g, i) => (
            <button key={g[0]} onClick={() => setTab(i)} className={cn('cursor-pointer whitespace-nowrap rounded-md px-2 py-0.5 text-xs', tab === i ? 'bg-accent-soft text-accent' : 'text-muted-foreground hover:bg-muted')}>{g[0]}</button>
          ))}
        </div>
        <div className="grid max-h-56 grid-cols-9 overflow-y-auto">
          {EMOJI[tab][1].map(e => (
            <button key={e} onClick={() => onPick(e)} className="cursor-pointer rounded-md p-1 text-xl hover:bg-muted">{e}</button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// 发图片 / 发文件按钮
export function FileButtons({ onFile }: { onFile: (f: File) => void }) {
  const img = React.useRef<HTMLInputElement>(null), file = React.useRef<HTMLInputElement>(null)
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }
  return (
    <>
      <Button variant="ghost" size="icon" title="发图片" onClick={() => img.current?.click()}><ImageIcon /></Button>
      <Button variant="ghost" size="icon" title="发送文件" onClick={() => file.current?.click()}><Paperclip /></Button>
      <input ref={img} type="file" accept="image/*" hidden onChange={pick} />
      <input ref={file} type="file" hidden onChange={pick} />
    </>
  )
}

// 粘贴截图直接上传
export function pastedFile(e: React.ClipboardEvent) {
  return [...(e.clipboardData?.files || [])][0]
}

// 三栏聊天布局（列表 / 聊天 / 资料），手机上只显示一栏
export function ChatLayout({ list, chat, info, hasChat }: { list: React.ReactNode; chat: React.ReactNode; info?: React.ReactNode; hasChat: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className={cn('flex w-full shrink-0 flex-col border-r bg-card md:w-[300px]', hasChat && 'max-md:hidden')}>{list}</div>
      <div className={cn('flex min-w-0 flex-1 flex-col bg-background', !hasChat && 'max-md:hidden')}>{chat}</div>
      {info && <div className="hidden w-[300px] shrink-0 overflow-y-auto border-l bg-card xl:block">{info}</div>}
    </div>
  )
}

export function confirmName(msg: string, name: string) {
  return window.prompt(msg) === name
}
