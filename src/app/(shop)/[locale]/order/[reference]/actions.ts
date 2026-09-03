'use server'

import { redirect } from 'next/navigation'
import { db } from '@/lib/server/db'
import { tokenMatches } from '@/lib/server/order-lookup'
import { cancelOrder } from '@/lib/server/orders'

export type CancelState = Record<string, never> | { errors: { _form: string[] } }

export async function cancelOrderAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const reference = String(form.get('reference') ?? '')
  const token = String(form.get('accessToken') ?? '')

  const order = await db.order.findUnique({
    where: { reference },
    select: { id: true, accessToken: true, locale: true },
  })

  // A wrong token and an unknown reference return the same thing. References
  // come from a monotonic sequence, so distinguishing them would let anyone
  // enumerate which orders exist — and cancelling is a destructive write.
  if (!order || !tokenMatches(order.accessToken, token)) {
    return { errors: { _form: ['notFound'] } }
  }

  // Idempotent: a second cancel returns { skipped } and releases nothing more.
  await cancelOrder(order.id, 'buyer_cancelled')

  redirect(`/${order.locale}/order/${reference}?t=${token}`)
}
