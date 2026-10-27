import 'server-only'

export type EmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'disabled' | 'alreadySent' | 'orderNotFound' | 'notPaid' }

/**
 * Sends the ticket-delivery email for a fulfilled order.
 *
 * Plan 06 ships this as a no-op (`EMAIL_ENABLED = false`); Plan 08 wires
 * Resend. The call site, the idempotency guard (`Order.emailSentAt IS NULL`),
 * the result shape and the "called AFTER the DB transaction" rule are fixed
 * here so Plan 08 is a drop-in.
 *
 * Must never run inside a Prisma transaction — the real implementation
 * will call Resend, which is network and can hang; the right place is
 * `webhook-dispatch.ts` after `fulfilOrder` returns.
 */
export async function emailFulfilledOrder(_orderId: string): Promise<EmailResult> {
  if (process.env.EMAIL_ENABLED !== 'true') {
    return { sent: false, reason: 'disabled' }
  }

  // PLAN-08: check Order.emailSentAt — return { sent: false, reason: 'alreadySent' } if set
  // PLAN-08: fetch order, return { sent: false, reason: 'orderNotFound' } if missing
  // PLAN-08: check order.status === 'PAID', return { sent: false, reason: 'notPaid' } if not
  // PLAN-08: call Resend, update Order.emailSentAt, return { sent: true, messageId: ... }

  return { sent: false, reason: 'disabled' }
}
