'use client'

import { useActionState, useState } from 'react'
import { LOCALES, type Locale } from '@/lib/shared/locale'
import type { EventFormState } from './actions'

const LOCALE_LABEL: Record<Locale, string> = { pl: 'Polski', en: 'English', de: 'Deutsch' }

const field =
  'min-h-[48px] w-full rounded-[2px] border border-[var(--color-border-input)] px-3 text-base ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[var(--color-accent)]'

export type EventFormValues = {
  slug: string
  venueId: string
  startsAtLocal: string
  capacity: number
  status: string
  pricePlnMajor: string
  priceEurMajor: string
  maxPerOrder: number
  translations: Record<Locale, { title: string; description: string; performers: string }>
}

export function EventForm({
  action,
  initial,
  venues,
  submitLabel,
}: {
  action: (prev: EventFormState, formData: FormData) => Promise<EventFormState>
  initial: EventFormValues
  venues: Array<{ id: string; name: string; city: string }>
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState(action, {} as EventFormState)
  const [tab, setTab] = useState<Locale>('pl')

  return (
    <form action={formAction} className="flex max-w-[800px] flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Adres URL (slug)</span>
        <input name="slug" defaultValue={initial.slug} required className={field} />
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Miejsce</span>
        <select name="venueId" defaultValue={initial.venueId} required className={field}>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.city}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Data i godzina (czas polski)</span>
        <input
          name="startsAt"
          type="datetime-local"
          defaultValue={initial.startsAtLocal}
          required
          className={field}
        />
      </label>

      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Pojemność</span>
          <input name="capacity" type="number" min={1} defaultValue={initial.capacity} required className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Maks. biletów na zamówienie</span>
          <input name="maxPerOrder" type="number" min={1} defaultValue={initial.maxPerOrder} className={field} />
        </label>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Cena PLN</span>
          <input name="pricePln" type="number" step="0.01" min="0" defaultValue={initial.pricePlnMajor} required className={field} />
        </label>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-semibold">Cena EUR</span>
          <input name="priceEur" type="number" step="0.01" min="0" defaultValue={initial.priceEurMajor} required className={field} />
        </label>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)]">
        Obie ceny ustawiane są ręcznie — system nie przelicza kursu. Cena w PLN
        umożliwia BLIK, cena w EUR umożliwia Klarna.
      </p>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Status</span>
        <select name="status" defaultValue={initial.status} className={field}>
          <option value="DRAFT">Szkic (niewidoczny)</option>
          <option value="ON_SALE">W sprzedaży</option>
          <option value="CLOSED">Sprzedaż zamknięta</option>
          <option value="CANCELLED">Odwołany</option>
        </select>
      </label>

      <fieldset className="border border-[var(--color-border)] p-4">
        <legend className="px-2 text-sm font-semibold">Treść koncertu</legend>

        <div role="tablist" className="mb-4 flex gap-2">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={tab === l}
              onClick={() => setTab(l)}
              className={`min-h-[40px] rounded-[2px] border px-3 text-sm ${
                tab === l
                  ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]'
                  : 'border-[var(--color-border-strong)]'
              }`}
            >
              {LOCALE_LABEL[l]}
            </button>
          ))}
        </div>

        {/* All three panels stay mounted so every field is submitted,
            regardless of which tab is visible. */}
        {LOCALES.map((l) => (
          <div key={l} hidden={tab !== l} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Tytuł</span>
              <input name={`${l}.title`} defaultValue={initial.translations[l].title} required className={field} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Wykonawcy</span>
              <input name={`${l}.performers`} defaultValue={initial.translations[l].performers} required className={field} />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Opis</span>
              <textarea
                name={`${l}.description`}
                defaultValue={initial.translations[l].description}
                required
                rows={5}
                className={`${field} py-2`}
              />
            </label>
          </div>
        ))}
      </fieldset>

      {state.error && (
        <p role="alert" className="border border-[var(--color-accent)] p-3 text-sm text-[var(--color-accent)]">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="min-h-[48px] rounded-[2px] bg-[var(--color-accent)] px-6 font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Zapisywanie…' : submitLabel}
      </button>
    </form>
  )
}
