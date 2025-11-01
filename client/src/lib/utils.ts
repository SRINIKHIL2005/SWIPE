export function genId(prefix: string = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function safeNumber(n: any, fallback = 0): number {
  const x = typeof n === 'string' ? Number(n.replace(/[^0-9.\-]/g, '')) : Number(n)
  return Number.isFinite(x) ? x : fallback
}

export function toPercent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`
}
