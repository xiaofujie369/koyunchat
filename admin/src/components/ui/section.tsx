import * as React from 'react'
import { Collapsible } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// 可点击展开的设置卡片：标题行显示当前状态摘要，点开才显示表单。展开状态按 id 记在浏览器里。
export function Section({ id, icon, title, summary, badge, defaultOpen = false, children }: {
  id: string; icon?: React.ReactNode; title: React.ReactNode; summary?: React.ReactNode; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode
}) {
  const key = 'kc_section_' + id
  const [open, setOpen] = React.useState(() => {
    try { const v = localStorage.getItem(key); return v === null ? defaultOpen : v === '1' } catch { return defaultOpen }
  })
  const change = (o: boolean) => { setOpen(o); try { localStorage.setItem(key, o ? '1' : '0') } catch { /* 隐私模式 */ } }
  return (
    <Collapsible.Root open={open} onOpenChange={change} className="rounded-[14px] border bg-card">
      <Collapsible.Trigger className="flex w-full cursor-pointer items-center gap-3 px-5 py-4 text-left outline-none hover:bg-card-soft rounded-[14px] focus-visible:ring-2 focus-visible:ring-ring/30">
        <ChevronRight className={cn('size-4 shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">{title}</span>
          {summary && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>}
        </span>
        {badge}
      </Collapsible.Trigger>
      <Collapsible.Content className="border-t px-5 py-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}
