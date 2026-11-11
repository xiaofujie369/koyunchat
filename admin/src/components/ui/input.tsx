import * as React from 'react'
import { cn } from '@/lib/utils'

export const fieldClass = 'w-full rounded-lg border bg-card px-3 text-sm text-foreground placeholder:text-faint outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-9', className)} {...props} />
}
export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-[90px] py-2 leading-relaxed', className)} {...props} />
}
// 原生下拉框：手机上体验最好，也省去很多兼容问题
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select className={cn(fieldClass, 'h-9 pr-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23a39d92%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[length:16px] bg-[right_10px_center] bg-no-repeat', className)} {...props} />
}
export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('mb-1.5 block text-[12.5px] font-medium text-muted-foreground', className)} {...props} />
}
export function Hint({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('mt-1.5 text-xs leading-relaxed text-faint', className)} {...props} />
}
// 表单一行：标签 + 控件 + 提示
export function Field({ label, hint, className, children }: { label?: React.ReactNode; hint?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('mb-4', className)}>
      {label && <Label>{label}</Label>}
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}
