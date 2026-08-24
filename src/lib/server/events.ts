import 'server-only'
import type { Event } from '@/generated/prisma/client'
import { Prisma } from '@/generated/prisma/client'
import { db } from './db'
import { recordAudit } from './audit'
import { eventInputSchema, type EventInput } from '@/lib/shared/schemas'
import { LOCALES } from '@/lib/shared/locale'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Koncert o adresie "${slug}" już istnieje.`)
    this.name = 'SlugTakenError'
  }
}

export class PriceChangeWhileHeldError extends Error {
  constructor(readonly held: number) {
    super(
      `Nie można zmienić ceny — ${held} bilet(ów) jest w trakcie zakupu. Spróbuj ponownie za kilka minut.`,
    )
    this.name = 'PriceChangeWhileHeldError'
  }
}

export class CapacityBelowSoldError extends Error {
  constructor(
    readonly sold: number,
    readonly held: number,
  ) {
    super(
      `Nie można zmniejszyć pojemności poniżej liczby sprzedanych i zarezerwowanych biletów (${sold} + ${held}).`,
    )
    this.name = 'CapacityBelowSoldError'
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

export async function createEvent(raw: EventInput, actorId: string): Promise<Event> {
  const input = eventInputSchema.parse(raw)

  try {
    const event = await db.event.create({
      data: {
        slug: input.slug,
        venueId: input.venueId,
        startsAt: input.startsAt,
        doorsAt: input.doorsAt ?? null,
        capacity: input.capacity,
        status: input.status,
        salesOpenAt: input.salesOpenAt ?? null,
        salesCloseAt: input.salesCloseAt ?? null,
        translations: {
          create: LOCALES.map((locale) => ({ locale, ...input.translations[locale] })),
        },
        ticketTypes: {
          create: [
            {
              pricePln: input.pricePln,
              priceEur: input.priceEur,
              maxPerOrder: input.maxPerOrder,
            },
          ],
        },
      },
    })

    await recordAudit({
      actorId,
      action: 'event.create',
      entityType: 'Event',
      entityId: event.id,
      meta: { slug: event.slug, capacity: event.capacity },
    })

    return event
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError(input.slug)
    throw e
  }
}

export async function updateEvent(
  id: string,
  raw: EventInput,
  actorId: string,
): Promise<Event> {
  const input = eventInputSchema.parse(raw)

  const existing = await db.event.findUniqueOrThrow({
    where: { id },
    include: { ticketTypes: true },
  })

  // Capacity may never fall below what is already committed to buyers.
  const sold = existing.ticketTypes.reduce((n, t) => n + t.soldCount, 0)
  const held = existing.ticketTypes.reduce((n, t) => n + t.heldCount, 0)
  if (input.capacity < sold + held) throw new CapacityBelowSoldError(sold, held)

  // Refuse price edits while someone is mid-checkout. Their order snapshotted
  // the old price and Stripe already holds a PaymentIntent for that amount;
  // changing it underneath them makes the confirmation page disagree with the
  // charge. Holds expire in 30 minutes, so this resolves itself.
  const priceChanged = existing.ticketTypes.some(
    (t) => t.pricePln !== input.pricePln || t.priceEur !== input.priceEur,
  )
  if (priceChanged && held > 0) throw new PriceChangeWhileHeldError(held)

  try {
    const event = await db.$transaction(async (tx) => {
      const updated = await tx.event.update({
        where: { id },
        data: {
          slug: input.slug,
          venueId: input.venueId,
          startsAt: input.startsAt,
          doorsAt: input.doorsAt ?? null,
          capacity: input.capacity,
          status: input.status,
          salesOpenAt: input.salesOpenAt ?? null,
          salesCloseAt: input.salesCloseAt ?? null,
        },
      })

      for (const locale of LOCALES) {
        await tx.eventTranslation.upsert({
          where: { eventId_locale: { eventId: id, locale } },
          create: { eventId: id, locale, ...input.translations[locale] },
          update: input.translations[locale],
        })
      }

      // Prices are edited on the single ticket type. Existing orders keep
      // their snapshotted unitPrice, so this never rewrites history.
      await tx.ticketType.updateMany({
        where: { eventId: id },
        data: {
          pricePln: input.pricePln,
          priceEur: input.priceEur,
          maxPerOrder: input.maxPerOrder,
        },
      })

      return updated
    })

    await recordAudit({
      actorId,
      action: 'event.update',
      entityType: 'Event',
      entityId: event.id,
      meta: { slug: event.slug, capacity: event.capacity, previousCapacity: existing.capacity },
    })

    return event
  } catch (e) {
    if (isUniqueViolation(e)) throw new SlugTakenError(input.slug)
    throw e
  }
}
