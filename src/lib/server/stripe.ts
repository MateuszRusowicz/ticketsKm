import 'server-only'
import Stripe from 'stripe'
import { env } from './env'

function createClient(): Stripe {
  // No apiVersion override — the SDK version pins it. Bumping SDK majors
  // is a separate plan item. Log Stripe.API_VERSION for observability.
  console.info(`[stripe] initialising client; sdk apiVersion=${Stripe.API_VERSION}`)
  return new Stripe(env.STRIPE_SECRET_KEY, { typescript: true })
}

const g = globalThis as unknown as { stripe?: Stripe }
export const stripe = g.stripe ?? createClient()
if (env.NODE_ENV !== 'production') g.stripe = stripe

export function stripeCurrency(c: 'PLN' | 'EUR'): 'pln' | 'eur' {
  return c === 'PLN' ? 'pln' : 'eur'
}

export function stripeAmount(order: {
  total: number
  currency: 'PLN' | 'EUR'
  id: string
}): number {
  if (order.total <= 0) {
    throw new Error(`stripeAmount: zero-amount order ${order.id} (total=${order.total})`)
  }
  return order.total
}
