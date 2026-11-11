import * as React from 'react'
import { Empty } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Row } from '@/lib/types'

// 排行条：一种颜色表示多少，数字写在旁边（文字用正文颜色）
export function BarList({ rows, empty = '暂无数据', valueKey = 'n', label, onPick }: {
  rows: Row[]; empty?: string; valueKey?: string; label?: (r: Row) => React.ReactNode; onPick?: (r: Row) => void
}) {
  const max = Math.max(1, ...rows.map(r => r[valueKey] || 0))
  const total = rows.reduce((a, r) => a + (r[valueKey] || 0), 0) || 1
  if (!rows.length || !rows.some(r => r[valueKey])) return <Empty className="py-6">{empty}</Empty>
  return (
    <div className="space-y-2.5">
      {rows.map(r => (
        <div key={r.name} className={cn('flex items-center gap-3 text-[13px]', onPick && 'cursor-pointer rounded-md hover:bg-card-soft')} onClick={() => onPick?.(r)}>
          <span className="w-28 shrink-0 truncate" title={r.name}>{label ? label(r) : r.name}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-chart" style={{ width: ((r[valueKey] || 0) / max) * 100 + '%' }} /></div>
          <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{r[valueKey]}（{Math.round(((r[valueKey] || 0) / total) * 100)}%）</span>
        </div>
      ))}
    </div>
  )
}

// 竖条图（时段分布用）：悬停显示数值，峰值直接标出来
export function ColumnChart({ values, labels, name, height = 150 }: { values: number[]; labels: string[]; name: string; height?: number }) {
  const [hover, setHover] = React.useState<number | null>(null)
  const max = Math.max(1, ...values)
  const peak = values.indexOf(Math.max(...values))
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <div className="relative" role="img" aria-label={name}>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {values.map((v, i) => (
          <div key={i} className="flex h-full flex-1 cursor-default flex-col justify-end" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <div className={cn('rounded-t-[4px] bg-chart transition-opacity', hover !== null && hover !== i && 'opacity-45')} style={{ height: Math.max(v ? 2 : 0, (v / max) * 100) + '%' }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[2px]">
        {labels.map((l, i) => <div key={i} className="flex-1 truncate text-center text-[10.5px] text-faint">{labels.length > 12 && i % 3 ? '' : l}</div>)}
      </div>
      {total > 0 && <div className="mt-2 text-xs text-muted-foreground">高峰：<b className="text-foreground">{labels[peak]}</b>，{values[peak]} 次浏览（占 {Math.round((values[peak] / total) * 100)}%）</div>}
      {hover !== null && (
        <div className="pointer-events-none absolute -top-2 z-10 rounded-lg border bg-card px-2.5 py-1.5 text-xs shadow-lg" style={{ left: `clamp(0px, calc(${((hover + 0.5) / values.length) * 100}% - 60px), calc(100% - 120px))` }}>
          <div className="text-faint">{labels[hover]}</div><b className="tabular-nums">{values[hover]}</b> 次浏览
        </div>
      )}
    </div>
  )
}

// 和上一周期比较
export function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="text-faint">{cur ? '上一周期为 0' : '—'}</span>
  const p = ((cur - prev) / prev) * 100
  if (Math.abs(p) < 0.05) return <span className="text-faint">与上一周期持平</span>
  return <span><span className={cn('font-medium tabular-nums', p > 0 ? 'text-ok' : 'text-bad')}>{p > 0 ? '↑ +' : '↓ '}{p.toFixed(1)}%</span> <span className="text-faint">较上一周期</span></span>
}

// 把表格导出成 CSV（Excel 能直接打开）
export function exportCSV(name: string, head: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const csv = '﻿' + [head, ...rows].map(r => r.map(esc).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = name + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
