import type { AvailabilityBand } from '@/lib/shared/public-event'

// Never the exact number remaining: it publishes the festival's sales figures,
// and "3 left" invites a stampede for a concert that then oversells under
// contention.
//
// Colour is not the only signal — the text carries the meaning on its own, for
// screen readers and for the colour-blind.
const STYLE: Record<AvailabilityBand, string> = {
  available: 'text-text-secondary',
  few: 'text-accent font-semibold',
  soldOut: 'text-text-secondary line-through',
}

export function AvailabilityBadge({ band, label }: { band: AvailabilityBand; label: string }) {
  return <span className={`text-sm ${STYLE[band]}`}>{label}</span>
}
