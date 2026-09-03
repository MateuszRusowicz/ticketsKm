import 'server-only'
import { sweepExpiredHoldsWith, type SweepResult } from '@/lib/shared/holds-sweep'
import { db } from './db'
import { expireOrder } from './orders'

/** The application-side binding. The CLI passes its own client instead. */
export function sweepExpiredHolds(now?: Date): Promise<SweepResult> {
  return sweepExpiredHoldsWith(db, (orderId) => expireOrder(orderId), now)
}
