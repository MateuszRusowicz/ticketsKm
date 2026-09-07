import type { Currency } from './money'

/**
 * Base payment method list per currency, used as the starting point for
 * computeAllowedPaymentMethods (server-side) and for display in the BuyBox
 * (client-side).
 *
 * The BuyBox display is necessarily approximate — SEPA guardrails (concurrent-
 * hold cap, near-sellout hide) are applied server-side on top of this list and
 * cannot be reproduced in a component without order context. The UI copy uses
 * hedging language ("m.in.") to signal this.
 *
 * PayPal (EUR-only): settles in seconds like a card, so it is NOT subject to
 * the SEPA concurrent-hold cap or near-sellout hide. Those limits exist because
 * SEPA holds seats for days; restricting PayPal would cut off sales for nothing.
 * Owner decision, 7 Sep 2026.
 */
export function basePaymentMethodsFor(currency: Currency): string[] {
  if (currency === 'PLN') {
    return ['card', 'blik', 'p24']
  }
  // EUR
  return ['card', 'klarna', 'sepa_debit', 'paypal']
}

/** Brand-name labels for every non-card method. Card is locale-specific and
 *  must be passed in as `cardLabel` from the caller's translation function. */
const BRAND_LABELS: Record<string, string> = {
  blik: 'BLIK',
  p24: 'Przelewy24',
  klarna: 'Klarna',
  sepa_debit: 'SEPA',
  paypal: 'PayPal',
}

/**
 * Human-readable label for a Stripe payment method id.
 *
 * Brand names (BLIK, Przelewy24, Klarna, SEPA, PayPal) are not translated —
 * they are proper nouns that appear the same in every locale. Only `card` is
 * locale-specific; pass the already-translated string as `cardLabel`.
 */
export function paymentMethodLabel(id: string, cardLabel: string): string {
  if (id === 'card') return cardLabel
  return BRAND_LABELS[id] ?? id
}

/**
 * Ordered list of human-readable labels for the methods available in a given
 * currency. Intended for the BuyBox "paying in …" hint line.
 *
 * The list is approximate — SEPA server-side guardrails are not applied here.
 * The UI copy uses hedging language to signal this.
 */
export function paymentMethodLabelsFor(currency: Currency, cardLabel: string): string[] {
  return basePaymentMethodsFor(currency).map((id) => paymentMethodLabel(id, cardLabel))
}
