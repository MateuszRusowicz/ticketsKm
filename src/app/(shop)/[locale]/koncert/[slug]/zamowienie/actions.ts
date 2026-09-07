'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { InsufficientCapacityError } from '@/lib/server/holds'
import {
  createOrder,
  EventNotPurchasableError,
  QuantityAboveMaxPerOrderError,
} from '@/lib/server/orders'
import { rateLimit } from '@/lib/server/ratelimit'
import { checkoutSchema, type CheckoutInput } from '@/lib/shared/checkout'

/** Per IP per minute. Generous for a human, expensive for a script. */
const CHECKOUT_RPM = 10

export type SubmitState =
  | Record<string, never>
  | { errors: Record<string, string[]>; values?: Partial<CheckoutInput> }

export async function submitCheckout(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const forwarded = (await headers()).get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || '0.0.0.0'

  // Returns the string value for a field, or undefined when the field is
  // absent or empty. File entries are discarded — every field here is text.
  const text = (key: string): string | undefined => {
    const value = form.get(key)
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  const quantity = Number(form.get('quantity'))

  // Build the echo payload unconditionally so that every error return can
  // include it and the component can repopulate the form without wiping what
  // the buyer typed. attendeeNames is read across all quantity slots even
  // when some are blank, so the component sees the partial state correctly.
  // Nothing sensitive is carried: there is no password field.
  const echoValues: Partial<CheckoutInput> = {
    ticketTypeId: text('ticketTypeId'),
    quantity: Number.isFinite(quantity) ? quantity : undefined,
    locale: text('locale') as CheckoutInput['locale'] | undefined,
    currency: text('currency') as CheckoutInput['currency'] | undefined,
    email: text('email'),
    firstName: text('firstName'),
    lastName: text('lastName'),
    phone: text('phone'),
    attendeeNames: Array.from(
      { length: Number.isFinite(quantity) ? quantity : 0 },
      (_, i) => {
        const v = form.get(`attendeeNames.${i}`)
        return typeof v === 'string' ? v : ''
      },
    ),
    needsInvoice: form.get('needsInvoice') === 'on',
    companyName: text('companyName'),
    nip: text('nip'),
    invoiceAddress: text('invoiceAddress'),
    acceptedTerms: form.get('acceptedTerms') === 'on' ? true : undefined,
  }

  if (!rateLimit(`checkout:${ip}`, CHECKOUT_RPM, 60_000)) {
    return { errors: { _form: ['rateLimited'] }, values: echoValues }
  }

  // Assembled by explicit index rather than by collecting whatever
  // attendeeNames.* fields happen to be present. A missing index fails loudly
  // here; collecting-and-sorting would silently shift every later name onto
  // the wrong ticket, with the count still matching.
  const attendeeNames: string[] = []
  for (let i = 0; i < quantity; i++) {
    const value = form.get(`attendeeNames.${i}`)
    if (typeof value !== 'string' || value.trim() === '') {
      return { errors: { attendeeNames: ['incomplete'] }, values: echoValues }
    }
    attendeeNames.push(value)
  }

  const parsed = checkoutSchema.safeParse({
    ticketTypeId: form.get('ticketTypeId'),
    quantity,
    locale: form.get('locale'),
    // Frozen at render: the switcher is hidden on this route, so what the
    // summary showed is what gets charged.
    currency: form.get('currency'),
    email: form.get('email'),
    firstName: form.get('firstName'),
    lastName: form.get('lastName'),
    phone: text('phone'),
    attendeeNames,
    needsInvoice: form.get('needsInvoice') === 'on',
    companyName: text('companyName'),
    nip: text('nip'),
    invoiceAddress: text('invoiceAddress'),
    acceptedTerms: form.get('acceptedTerms') === 'on',
  })

  if (!parsed.success) {
    // Zod 4 removed ZodError.flatten() in favour of z.flattenError().
    return {
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: echoValues,
    }
  }

  let result
  try {
    result = await createOrder(parsed.data)
  } catch (e) {
    // Every one of these is a normal outcome the buyer can act on, so they
    // become form-level copy rather than a 500.
    if (e instanceof InsufficientCapacityError) return { errors: { _form: ['soldOut'] }, values: echoValues }
    if (e instanceof QuantityAboveMaxPerOrderError) return { errors: { _form: ['aboveMax'] }, values: echoValues }
    if (e instanceof EventNotPurchasableError) return { errors: { _form: ['notPurchasable'] }, values: echoValues }
    throw e
  }

  // The token is required: the reference comes from a monotonic sequence and
  // is trivially enumerable, so it cannot be the only thing guarding a page
  // that shows buyer details and offers a cancel button.
  redirect(`/${parsed.data.locale}/order/${result.reference}?t=${result.accessToken}`)
}
