import * as React from 'react'

export interface Point { label: string; value: number; extra?: string }

// 一组数据的面积图：一条线、一个纵轴；悬停显示十字线和数值。
// 颜色用 --chart（浅色 / 深色各一套，已校验对比度）；文字一律用正文颜色。
export default function AreaChart({ data, height = 280, unit = '', name }: { data: Point[]; height?: number; unit?: string; name: string }) {
  const wrap = React.useRef<HTMLDivElement>(null)
  const [w, setW] = React.useState(800)
  const [hover, setHover] = React.useState<number | null>(null)
  React.useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(e => setW(Math.max(280, e[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pad = { l: 44, r: 12, t: 12, b: 28 }
  const iw = w - pad.l - pad.r, ih = height - pad.t - pad.b
  const max = niceMax(Math.max(0, ...data.map(d => d.value)))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f))
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw)
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const pts = data.map((d, i) => [x(i), y(d.value)] as [number, number])
  const line = smoothPath(pts)
  const area = pts.length ? line + ` L${pts[pts.length - 1][0]},${pad.t + ih} L${pts[0][0]},${pad.t + ih} Z` : ''
  // 横轴标签最多显示约 10 个，避免挤在一起
  const step = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 72))))
  const gid = React.useId().replace(/:/g, '')

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * iw
    setHover(Math.max(0, Math.min(data.length - 1, Math.round((px / iw) * (data.length - 1)))))
  }
  const h = hover !== null ? data[hover] : null
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) - 80, 0), w - 168) : 0

  return (
    <div ref={wrap} className="relative w-full select-none" role="img" aria-label={`${name}趋势图`}>
      <svg width={w} height={height} className="block overflow-visible">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--chart)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--faint)">{t}{unit}</text>
          </g>
        ))}
        {data.map((d, i) => (i % step === 0 || i === data.length - 1) && (data.length - 1 - i >= step / 2 || i === data.length - 1) ? (
          <text key={d.label} x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--faint)">{d.label.slice(5)}</text>
        ) : null)}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke="var(--chart)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--faint)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(data[hover].value)} r="5" fill="var(--chart)" stroke="var(--card)" strokeWidth="2" />
          </g>
        )}
        {/* 透明的大范围感应区，比线本身好点 */}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove} />
      </svg>
      {h && (
        <div className="pointer-events-none absolute top-0 z-10 w-[168px] rounded-lg border bg-card px-3 py-2 text-xs shadow-lg" style={{ left: tipLeft }}>
          <div className="text-faint">{h.label}</div>
          <div className="mt-0.5 flex items-center gap-1.5"><span className="size-2 rounded-full bg-chart" /><span className="text-muted-foreground">{name}</span><b className="ml-auto text-sm text-foreground tabular-nums">{h.value}{unit}</b></div>
          {h.extra && <div className="mt-0.5 text-faint">{h.extra}</div>}
        </div>
      )}
    </div>
  )
}

// 纵轴上限取整（1、2、5 × 10 的幂），刻度好读
function niceMax(v: number) {
  if (v <= 4) return 4
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.ceil((m * p) / 4) * 4
  return v
}

// 单调三次曲线：平滑但不会冲出数据范围（不会画出负数）
function smoothPath(p: [number, number][]) {
  if (!p.length) return ''
  if (p.length < 3) return 'M' + p.map(q => q.join(',')).join(' L')
  const n = p.length, dx: number[] = [], m: number[] = [], t: number[] = []
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = (p[i + 1][1] - p[i][1]) / dx[i] }
  t[0] = m[0]; t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])
  let d = `M${p[0][0]},${p[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C${p[i][0] + h},${p[i][1] + h * t[i]} ${p[i + 1][0] - h},${p[i + 1][1] - h * t[i + 1]} ${p[i + 1][0]},${p[i + 1][1]}`
  }
  return d
}
