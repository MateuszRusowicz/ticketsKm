'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/server/auth'
import {
  CapacityBelowSoldError,
  createEvent,
  PriceChangeWhileHeldError,
  SlugTakenError,
  updateEvent,
} from '@/lib/server/events'
import { warsawLocalToUtc } from '@/lib/server/time'
import { toMinor } from '@/lib/shared/money'

export type EventFormState = { error?: string }

function readForm(formData: FormData) {
  return {
    slug: String(formData.get('slug') ?? ''),
    venueId: String(formData.get('venueId') ?? ''),
    // NOT new Date(...): the input carries no timezone — see Step 1.
    startsAt: warsawLocalToUtc(String(formData.get('startsAt') ?? '')),
    capacity: Number(formData.get('capacity')),
    status: String(formData.get('status') ?? 'DRAFT') as 'DRAFT',
    // Staff type "80.00"; the database stores 8000.
    pricePln: toMinor(Number(formData.get('pricePln'))),
    priceEur: toMinor(Number(formData.get('priceEur'))),
    maxPerOrder: Number(formData.get('maxPerOrder') ?? 10),
    translations: {
      pl: {
        title: String(formData.get('pl.title') ?? ''),
        description: String(formData.get('pl.description') ?? ''),
        performers: String(formData.get('pl.performers') ?? ''),
      },
      en: {
        title: String(formData.get('en.title') ?? ''),
        description: String(formData.get('en.description') ?? ''),
        performers: String(formData.get('en.performers') ?? ''),
      },
      de: {
        title: String(formData.get('de.title') ?? ''),
        description: String(formData.get('de.description') ?? ''),
        performers: String(formData.get('de.performers') ?? ''),
      },
    },
  }
}

function toMessage(e: unknown): string {
  if (
    e instanceof SlugTakenError ||
    e instanceof CapacityBelowSoldError ||
    e instanceof PriceChangeWhileHeldError
  ) {
    return e.message
  }
  console.error('[admin/events]', e)
  return 'Nie udało się zapisać koncertu. Sprawdź poprawność pól.'
}

export async function createEventAction(
  _prev: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // Authorisation inside the action, not in middleware. Server Actions are
  // publicly callable HTTP endpoints.
  const admin = await requireAdmin()

  try {
    await createEvent(readForm(formData), admin.id)
  } catch (e) {
    return { error: toMessage(e) }
  }

  revalidatePath('/admin/events')
  redirect('/admin/events')
}

export async function updateEventAction(
  id: string,
  _prev: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const admin = await requireAdmin()

  try {
    await updateEvent(id, readForm(formData), admin.id)
  } catch (e) {
    return { error: toMessage(e) }
  }

  revalidatePath('/admin/events')
  redirect('/admin/events')
}
