import { z } from 'zod'
import { LOCALES } from './locale'

const translationSchema = z.object({
  title: z.string().min(1, 'Tytuł jest wymagany'),
  description: z.string().min(1, 'Opis jest wymagany'),
  performers: z.string().min(1, 'Wykonawcy są wymagani'),
  note: z.string().optional(),
})

export const eventInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Slug może zawierać tylko małe litery, cyfry i myślniki'),
  venueId: z.string().uuid(),
  startsAt: z.coerce.date(),
  doorsAt: z.coerce.date().optional().nullable(),
  capacity: z.number().int().positive(),
  status: z.enum(['DRAFT', 'ON_SALE', 'SOLD_OUT', 'CLOSED', 'CANCELLED']),
  salesOpenAt: z.coerce.date().optional().nullable(),
  salesCloseAt: z.coerce.date().optional().nullable(),
  // Minor units. Integers only — see the Global Constraints.
  pricePln: z.number().int().nonnegative(),
  priceEur: z.number().int().nonnegative(),
  maxPerOrder: z.number().int().positive().max(50).default(10),
  translations: z.object(
    Object.fromEntries(LOCALES.map((l) => [l, translationSchema])) as Record<
      (typeof LOCALES)[number],
      typeof translationSchema
    >,
  ),
})

export type EventInput = z.infer<typeof eventInputSchema>
