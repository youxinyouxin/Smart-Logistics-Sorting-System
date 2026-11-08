import type { ReactNode } from 'react'

type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'brand' | 'demo'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function DemoBadge({ date }: { date?: string }) {
  return <Badge tone="demo">{date ? `演示数据 · ${date}` : '演示数据'}</Badge>
}
