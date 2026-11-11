import * as React from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-[14px] border bg-card', className)} {...props} />
}
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center gap-2.5 border-b px-5 py-3.5 text-[15px] font-semibold', className)} {...props} />
}
export function CardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}
export function Stat({ k, v, s, vClass }: { k: React.ReactNode; v: React.ReactNode; s?: React.ReactNode; vClass?: string }) {
  return (
    <Card className="px-[18px] py-4">
      <div className="text-[12.5px] text-muted-foreground">{k}</div>
      <div className={cn('mt-1 text-[26px] font-bold tabular-nums', vClass)}>{v}</div>
      {s && <div className="text-xs text-faint">{s}</div>}
    </Card>
  )
}
export function Empty({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('py-10 text-center text-sm text-faint', className)}>{children}</div>
}
