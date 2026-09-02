/**
 * Order reference formatting.
 *
 * Lives in shared/ so CLI scripts and tests can use it without pulling in
 * `server-only`. The database-bound generator that draws the next sequence
 * value is in `src/lib/server/order-reference.ts`.
 */

export const REFERENCE_RE = /^KM-\d{4}-\d{6}$/

// Six digits. The festival sells order counts in the thousands per year, so
// this is roughly three orders of magnitude of headroom; the guard exists so
// that if it is ever wrong we fail loudly rather than issuing a malformed
// reference that no longer matches REFERENCE_RE.
const MAX_SEQ = 1_000_000

export class OrderReferenceOverflow extends Error {
  constructor(readonly seq: number) {
    super(`Order reference sequence exhausted at ${seq}`)
    this.name = 'OrderReferenceOverflow'
  }
}

export function formatOrderReference(seq: number, year: number): string {
  if (seq >= MAX_SEQ) throw new OrderReferenceOverflow(seq)
  return `KM-${year}-${String(seq).padStart(6, '0')}`
}
