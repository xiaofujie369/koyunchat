import * as React from 'react'
import { cn } from '@/lib/utils'

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return <div className="w-full overflow-x-auto"><table className={cn('w-full border-collapse text-[13px]', className)} {...props} /></div>
}
export function Th({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('whitespace-nowrap border-b bg-card-soft px-3 py-2.5 text-left text-xs font-medium text-muted-foreground', className)} {...props} />
}
export function Td({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('border-b px-3 py-2.5 align-middle', className)} {...props} />
}
export function Tr({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('hover:bg-card-soft/70', className)} {...props} />
}
