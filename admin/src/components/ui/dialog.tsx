import * as React from 'react'
import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

// 用法：<Modal open title="标题" onClose={...} footer={<按钮/>}>内容</Modal>
export function Modal({ open = true, title, onClose, footer, size = 'md', children }: {
  open?: boolean; title: React.ReactNode; onClose: () => void; footer?: React.ReactNode; size?: 'md' | 'lg' | 'xl'; children: React.ReactNode
}) {
  return (
    <D.Root open={open} onOpenChange={o => { if (!o) onClose() }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content
          aria-describedby={undefined}
          className={cn('fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border bg-card shadow-2xl outline-none',
            size === 'md' && 'max-w-[480px]', size === 'lg' && 'max-w-[720px]', size === 'xl' && 'max-w-[960px]')}
        >
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <D.Title className="flex-1 truncate text-[15px] font-semibold">{title}</D.Title>
            <D.Close className="cursor-pointer rounded-md p-1 text-faint hover:bg-muted hover:text-foreground"><X className="size-4" /></D.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
