import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-[opacity,background-color,color] cursor-pointer disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        accent: 'bg-accent text-accent-foreground hover:opacity-90',
        outline: 'border bg-card text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        danger: 'border bg-card text-bad hover:bg-bad-soft',
        link: 'text-accent underline-offset-4 hover:underline px-0',
      },
      size: {
        default: 'h-9 px-4 text-sm',
        sm: 'h-8 px-3 text-[13px]',
        xs: 'h-7 px-2.5 text-xs',
        icon: 'size-8',
        lg: 'h-11 px-6 text-[15px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}
export { buttonVariants }
