'use client'

import { useForm, useWatch } from 'react-hook-form'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { checkoutSchema, type CheckoutInput } from '@/lib/shared/checkout'

type Props = {
  ticketTypeId: string
  quantity: number
  locale: CheckoutInput['locale']
  currency: CheckoutInput['currency']
  termsHref: string
  privacyHref: string
}

export function CheckoutForm({
  ticketTypeId,
  quantity,
  locale,
  currency,
  termsHref,
  privacyHref,
}: Props) {
  const t = useTranslations('checkout')
  const tv = useTranslations('validation')
  const [submitted, setSubmitted] = useState(false)

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CheckoutInput>({
    resolver: standardSchemaResolver(checkoutSchema),
    defaultValues: {
      ticketTypeId,
      quantity,
      locale,
      currency,
      needsInvoice: false,
      // One empty slot per ticket. Quantity is fixed for the life of this
      // page — it arrives in the URL — so the fields cannot be destroyed by
      // a quantity change mid-typing.
      attendeeNames: Array.from({ length: quantity }, () => ''),
    },
  })

  // useWatch, not watch(): it subscribes to this one field instead of
  // re-rendering the whole form on every keystroke, and watch() returns a
  // function React Compiler cannot memoize, which makes it skip the component.
  const needsInvoice = useWatch({ control, name: 'needsInvoice' })

  /** Zod carries message keys, not sentences, so errors land in the buyer's language. */
  const msg = (key?: string) => (key ? tv(key as 'required') : undefined)

  function onValid(values: CheckoutInput) {
    // PLAN-04: replace with createOrder() — see steps/04-inventory.md.
    // Deliberately creates nothing: order creation needs the transactional
    // capacity hold and its concurrency tests, which are the next plan.
    console.info('checkout payload', values)
    setSubmitted(true)
  }

  if (submitted) {
    return <p className="mt-8 border-l-4 border-accent bg-surface px-4 py-3">{t('stub')}</p>
  }

  return (
    <form onSubmit={handleSubmit(onValid)} className="mt-8 max-w-[800px]" noValidate>
      <input type="hidden" {...register('ticketTypeId')} />
      <input type="hidden" {...register('quantity', { valueAsNumber: true })} />
      <input type="hidden" {...register('locale')} />
      <input type="hidden" {...register('currency')} />

      <fieldset className="border-0 p-0">
        <legend className="text-xl">{t('buyerSection')}</legend>

        <Field label={t('email')} hint={t('emailHint')} error={msg(errors.email?.message)}>
          <input type="email" autoComplete="email" {...register('email')} className={INPUT} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('firstName')} error={msg(errors.firstName?.message)}>
            <input autoComplete="given-name" {...register('firstName')} className={INPUT} />
          </Field>
          <Field label={t('lastName')} error={msg(errors.lastName?.message)}>
            <input autoComplete="family-name" {...register('lastName')} className={INPUT} />
          </Field>
        </div>

        <Field label={t('phone')} error={msg(errors.phone?.message)}>
          <input type="tel" autoComplete="tel" {...register('phone')} className={INPUT} />
        </Field>
      </fieldset>

      <fieldset className="mt-8 border-0 p-0">
        <legend className="text-xl">{t('attendeesSection')}</legend>
        {errors.attendeeNames?.message && (
          <p className="mt-2 text-sm text-danger">{msg(errors.attendeeNames.message)}</p>
        )}
        {Array.from({ length: quantity }, (_, i) => (
          <Field
            key={i}
            label={t('attendeeLabel', { number: i + 1 })}
            error={msg(errors.attendeeNames?.[i]?.message)}
          >
            <input {...register(`attendeeNames.${i}` as const)} className={INPUT} />
          </Field>
        ))}
      </fieldset>

      <fieldset className="mt-8 border-0 p-0">
        <label className="flex min-h-[48px] items-center gap-3">
          <input type="checkbox" {...register('needsInvoice')} className="size-5" />
          <span>{t('needsInvoice')}</span>
        </label>

        {needsInvoice && (
          <div className="mt-2">
            <Field label={t('companyName')} error={msg(errors.companyName?.message)}>
              <input {...register('companyName')} className={INPUT} />
            </Field>
            <Field label={t('nip')} error={msg(errors.nip?.message)}>
              <input {...register('nip')} className={INPUT} />
            </Field>
            <Field label={t('invoiceAddress')} error={msg(errors.invoiceAddress?.message)}>
              <input {...register('invoiceAddress')} className={INPUT} />
            </Field>
          </div>
        )}
      </fieldset>

      <label className="mt-8 flex min-h-[48px] items-start gap-3">
        <input type="checkbox" {...register('acceptedTerms')} className="mt-1 size-5" />
        <span>
          {/* Tag syntax, not {placeholders}: next-intl's rich text matches
              <terms>…</terms> in the message. With a placeholder the callback
              never fires and the checkbox ships with no links at all. */}
          {t.rich('acceptedTerms', {
            terms: (chunks) => (
              <a href={termsHref} className="text-accent underline">
                {chunks}
              </a>
            ),
            privacy: (chunks) => (
              <a href={privacyHref} className="text-accent underline">
                {chunks}
              </a>
            ),
          })}
        </span>
      </label>
      {errors.acceptedTerms?.message && (
        <p className="text-sm text-danger">{msg(errors.acceptedTerms.message)}</p>
      )}

      <button
        type="submit"
        className="mt-8 min-h-[48px] bg-accent px-6 text-base text-white hover:opacity-90"
      >
        {t('submit')}
      </button>
    </form>
  )
}

// 1rem, or iOS zooms the page when the field takes focus.
const INPUT = 'min-h-[48px] w-full border border-border px-3 text-base'

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="mt-4 block">
      <span className="block text-sm text-text-secondary">{label}</span>
      {hint && <span className="block text-sm text-text-secondary">{hint}</span>}
      {children}
      {error && <span className="mt-1 block text-sm text-danger">{error}</span>}
    </label>
  )
}
