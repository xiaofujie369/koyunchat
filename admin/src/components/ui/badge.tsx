import * as React from 'react'
import { cn } from '@/lib/utils'

const tones = {
  default: 'bg-muted text-muted-foreground',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-accent-soft text-accent',
  tg: 'bg-[#229ed9] text-white',
}
export function Badge({ tone = 'default', className, ...props }: React.ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-px text-xs font-medium', tones[tone], className)} {...props} />
}
