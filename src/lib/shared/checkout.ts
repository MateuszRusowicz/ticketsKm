import { z } from 'zod'
import { LOCALES } from './locale'
import { CURRENCIES } from './money'

/**
 * Cap on an attendee name.
 *
 * Not cosmetic: the name is printed into a fixed-width `pdf-lib` layout in
 * Plan 05, next to the QR's quiet zone. A 200-character name is a rendering
 * bug, not a harmless input.
 */
export const MAX_NAME_LENGTH = 80

/**
 * Turn a user-supplied `?q=` into a quantity we are willing to render.
 *
 * Clamps rather than rejects: a buyer who asks for 99 tickets should get the
 * maximum with an explanation, not an error page they cannot act on. Returns
 * 0 when nothing is available, so a sold-out concert never offers "1".
 */
export function clampQuantity(
  raw: string | undefined,
  maxPerOrder: number,
  available: number,
): number {
  const ceiling = Math.max(0, Math.min(maxPerOrder, available))
  if (ceiling === 0) return 0

  // Deliberately strict: Number('') is 0, Number('2.5') is 2.5 and
  // Number('1e3') is 1000, none of which is a quantity someone typed.
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(parsed) || parsed < 1) return 1

  return Math.min(parsed, ceiling)
}

const trimmedName = z
  .string()
  .trim()
  .min(1, 'required')
  .max(MAX_NAME_LENGTH, 'tooLong')

/**
 * The checkout payload.
 *
 * Lives in shared/ because Plan 04's server action validates with exactly this
 * schema. Field names therefore match the `Order` columns they populate —
 * firstName/lastName/needsInvoice/invoiceAddress, not buyerName/wantsInvoice/
 * address — so no mapping layer is needed later.
 */
export const checkoutSchema = z
  .object({
    // Carried through for Plan 04: the hold targets this ticket type.
    // z.uuid(), not z.string().uuid(): the latter is deprecated in Zod 4.
    // Note it checks the RFC 4122 version and variant bits, not just the
    // shape — a hand-written "1111-1111-…" placeholder is rejected.
    ticketTypeId: z.uuid(),
    // Capped, not merely positive. clampQuantity() runs at render time only;
    // without a bound here one crafted POST holds an entire venue for the
    // full 30-minute window. createOrder additionally re-checks against the
    // concert's own maxPerOrder, which is the authoritative limit — this is
    // the blunt backstop that keeps an absurd payload from reaching it.
    quantity: z.number().int().positive().max(50),
    locale: z.enum(LOCALES),
    currency: z.enum(CURRENCIES),

    email: z.email('email'),
    firstName: trimmedName,
    lastName: trimmedName,
    phone: z.string().trim().max(40).optional(),

    // One per admission, since the 27 Aug 2026 decision.
    attendeeNames: z.array(trimmedName),

    needsInvoice: z.boolean(),
    companyName: z.string().trim().max(200).optional(),
    nip: z.string().trim().max(20).optional(),
    invoiceAddress: z.string().trim().max(300).optional(),

    // Form-only; there is no column for it. The acceptance is recorded by the
    // order existing at all.
    acceptedTerms: z.literal(true, { message: 'terms' }),
  })
  .superRefine((value, ctx) => {
    // The rule most likely to be got wrong, because quantity is owned by a
    // different component on a different route.
    if (value.attendeeNames.length !== value.quantity) {
      ctx.addIssue({
        code: 'custom',
        path: ['attendeeNames'],
        message: 'attendeeName',
      })
    }

    // Optional fields that become required. Written explicitly rather than as
    // a discriminated union so each missing field is reported on itself,
    // instead of the whole object failing with one opaque message.
    if (value.needsInvoice) {
      for (const field of ['companyName', 'nip', 'invoiceAddress'] as const) {
        if (!value[field]) {
          ctx.addIssue({ code: 'custom', path: [field], message: 'required' })
        }
      }
    }
  })

export type CheckoutInput = z.infer<typeof checkoutSchema>
