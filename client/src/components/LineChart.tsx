import { useEffect, useRef, useState } from 'react'

// Multi-series SVG line chart with a y scale, x ticks and gridlines. The hover position can be
// shared between charts (and a map) by passing hover/onHover; otherwise it's kept locally.

// marks: indexes of points to circle (flagged outliers/trends).
export interface LineSeries { label: string; values: (number | null)[]; color: string; marks?: number[] }

export const SERIES_COLORS = ['#e11d48', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#64748b']

const PAD_L = 40, PAD_R = 8, PAD_T = 8, PAD_B = 20

// Round step for ~count intervals across range: 1, 2 or 5 × a power of ten.
function niceStep(range: number, count: number) {
  const raw = range / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag
}

// Clock-aligned ticks for x values in seconds from t0 (epoch ms).
export function timeTicks(x: number[], t0: number, count = 6) {
  const span = x[x.length - 1] - x[0]
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]
  const step = steps.find(s => span / s <= count) ?? steps[steps.length - 1]
  const startAbs = Math.ceil((t0 / 1000 + x[0]) / step) * step
  const ticks: number[] = []
  for (let a = startAbs; a <= t0 / 1000 + x[x.length - 1]; a += step) ticks.push(a - t0 / 1000)
  return ticks
}

// Evenly spaced ticks for index-based x (e.g. one point per flight).
export function indexTicks(n: number, count = 6) {
  if (n <= 1) return [0]
  const step = Math.max(1, Math.ceil((n - 1) / count))
  const ticks: number[] = []
  for (let i = 0; i < n; i += step) ticks.push(i)
  if (ticks[ticks.length - 1] !== n - 1 && n - 1 - ticks[ticks.length - 1] >= step / 2) ticks.push(n - 1)
  return ticks
}

export function LineChart({
  title, x, series, unit = '', xLabel, xTicks, digits = 0, height: heightProp, hover: hoverProp, onHover,
}: {
  title: string
  x: number[]
  series: LineSeries[]
  unit?: string
  xLabel: (x: number) => string
  xTicks?: number[]
  digits?: number
  height?: number
  hover?: number | null
  onHover?: (i: number | null) => void
}) {
  const [localHover, setLocalHover] = useState<number | null>(null)
  const hover = onHover ? (hoverProp ?? null) : localHover
  const setHover = onHover ?? setLocalHover
  const ref = useRef<SVGSVGElement>(null)
  // Draw at the real pixel width so labels stay readable on a phone.
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const height = heightProp ?? Math.round(Math.min(200, Math.max(150, W * 0.38)))
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null)
  if (x.length < 2 || all.length < 2) return null

  let lo = Math.min(...all), hi = Math.max(...all)
  if (hi - lo < 1e-6) { lo -= 1; hi += 1 }
  const step = niceStep(hi - lo, 4)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const yTicks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(v)
  const yDigits = step < 1 ? Math.max(digits, Math.ceil(-Math.log10(step))) : 0

  const x0 = x[0], x1 = x[x.length - 1]
  const plotW = W - PAD_L - PAD_R, plotH = height - PAD_T - PAD_B
  const px = (v: number) => PAD_L + ((v - x0) / (x1 - x0 || 1)) * plotW
  const py = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * plotH

  const path = (vals: (number | null)[]) => {
    let d = '', pen = false
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return }
      d += `${pen ? 'L' : 'M'}${px(x[i]).toFixed(1)},${py(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  function onMove(e: React.PointerEvent) {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const sx = ((e.clientX - r.left) / r.width) * W
    const xv = x0 + ((sx - PAD_L) / plotW) * (x1 - x0)
    let best = 0
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - xv) < Math.abs(x[best] - xv)) best = i
    setHover(best)
  }

  const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(digits))
  let ticksX = (xTicks ?? [x0, x1]).filter(t => t >= x0 && t <= x1)
  while (ticksX.length > 2 && plotW / ticksX.length < 64) ticksX = ticksX.filter((_, i) => i % 2 === 0) // room for labels
  return (
    <div ref={box}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
        <span className="font-medium text-foreground">{title}{unit && <span className="font-normal text-muted-foreground"> ({unit.trim()})</span>}</span>
        {hover != null && <span className="tabular-nums text-muted-foreground">{xLabel(x[hover])}</span>}
        {series.map(s => (
          <span key={s.label} className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
            <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: s.color }} />
            {s.label}{hover != null && <span className="text-foreground"> {fmt(s.values[hover])}</span>}
          </span>
        ))}
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full touch-pan-y select-none rounded bg-muted/30"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={py(v)} y2={py(v)} className="stroke-border" strokeWidth="0.7" />
            <text x={PAD_L - 5} y={py(v) + 3.5} textAnchor="end" className="fill-muted-foreground" fontSize="10">{v.toFixed(yDigits)}</text>
          </g>
        ))}
        {ticksX.map((t, k) => {
          const label = xLabel(t)
          const repeat = k > 0 && label === xLabel(ticksX[k - 1])
          const anchor = px(t) < PAD_L + 24 ? 'start' : px(t) > W - PAD_R - 24 ? 'end' : 'middle'
          return (
            <g key={t}>
              <line x1={px(t)} x2={px(t)} y1={PAD_T} y2={PAD_T + plotH} className="stroke-border" strokeWidth="0.5" strokeDasharray="2 3" />
              {!repeat && <text x={px(t)} y={height - 5} textAnchor={anchor} className="fill-muted-foreground" fontSize="10">{label}</text>}
            </g>
          )
        })}
        {series.map(s => (
          <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" />
        ))}
        {series.flatMap(s => (s.marks ?? []).filter(i => s.values[i] != null).map(i => (
          <circle key={`${s.label}-${i}`} cx={px(x[i])} cy={py(s.values[i]!)} r="5" fill="none" stroke={s.color} strokeWidth="2">
            <title>{`${s.label}: ${s.values[i]!.toFixed(digits)} — flagged`}</title>
          </circle>
        )))}
        {hover != null && (
          <line x1={px(x[hover])} x2={px(x[hover])} y1={PAD_T} y2={PAD_T + plotH} className="stroke-foreground/60" strokeWidth="1" />
        )}
      </svg>
    </div>
  )
}
