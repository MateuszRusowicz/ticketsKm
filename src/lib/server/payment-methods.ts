import 'server-only'
import { db } from './db'
import { env } from './env'

const IN_FLIGHT_PI_STATUSES = [
  'processing',
  'requires_action',
  'requires_capture',
  'requires_confirmation',
] as const

/**
 * Server-side allowed-payment-methods computation.
 *
 * Enforced via `payment_method_types` — `automatic_payment_methods` cannot;
 * it has no per-order block-list. Stripe refuses confirmation for any method
 * not in the allow-list, so this is a real guardrail, not client-side hiding.
 *
 * SEPA (EUR-only) has three guardrails:
 *  1. Cap on concurrent in-flight SEPA holds (SEPA_HOLD_CAP_SHARE, default 10%)
 *  2. Near-sellout hide (SELLOUT_HIDE_THRESHOLD, default 20%)
 *  3. Small-concert floor guard: if floor(capacity * share) < 1, SEPA is allowed
 *     unconditionally so a 5-seat concert doesn't disable SEPA at count 0.
 */
export async function computeAllowedPaymentMethods(orderId: string): Promise<string[]> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      currency: true,
      items: {
        select: {
          ticketType: {
            select: {
              eventId: true,
              event: { select: { capacity: true } },
            },
          },
        },
      },
    },
  })

  const methods = new Set<string>(['card'])

  if (order.currency === 'PLN') {
    methods.add('blik')
    methods.add('p24')
  } else {
    // EUR
    methods.add('klarna')

    const eventId = order.items[0].ticketType.eventId
    const capacity = order.items[0].ticketType.event.capacity

    // Near-sellout — cheaper than the SEPA-cap join.
    const totals = await db.ticketType.aggregate({
      where: { eventId },
      _sum: { soldCount: true, heldCount: true },
    })
    const available = capacity - (totals._sum.soldCount ?? 0) - (totals._sum.heldCount ?? 0)
    const nearSellout = available <= Math.floor(capacity * env.SELLOUT_HIDE_THRESHOLD)

    // SEPA cap — count in-flight (any of the four PI states), not just processing.
    // The in-flight population includes requires_confirmation from the moment
    // createPaymentIntent claims an order, so the cap activates immediately.
    const sepaCap = Math.floor(capacity * env.SEPA_HOLD_CAP_SHARE)
    let sepaBlocked = false
    if (sepaCap >= 1) {
      // Floor guard: if capacity is too small to have a meaningful cap (e.g.
      // a 5-seat concert with 10% share → 0), skip the count and allow SEPA
      // unconditionally — otherwise sepaHolds >= 0 would always block it.
      const sepaHolds = await db.order.count({
        where: {
          status: 'PENDING',
          paymentIntentStatus: { in: [...IN_FLIGHT_PI_STATUSES] },
          paymentMethodType: 'sepa_debit',
          items: { some: { ticketType: { eventId } } },
        },
      })
      sepaBlocked = sepaHolds >= sepaCap
    }

    if (!nearSellout && !sepaBlocked) methods.add('sepa_debit')
  }

  return [...methods]
}
