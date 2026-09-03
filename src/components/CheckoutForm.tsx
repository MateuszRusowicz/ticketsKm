'use client'

import { useForm, useWatch } from 'react-hook-form'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { useTranslations } from 'next-intl'
import { useActionState } from 'react'
import {
  submitCheckout,
  type SubmitState,
} from '@/app/(shop)/[locale]/koncert/[slug]/zamowienie/actions'
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

  // The action is the source of truth: it re-validates with the same Zod
  // schema server-side, then redirects on success, so there is no success
  // branch to render here.
  const [state, action] = useActionState<SubmitState, FormData>(submitCheckout, {})
  const serverErrors = 'errors' in state ? state.errors : undefined
  const formError = serverErrors?._form?.[0]

  const {
    register,
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

  /**
   * Server error first, client error second.
   *
   * The form submits natively via `action`, so react-hook-form's
   * handleSubmit never runs and its resolver never fires on submit — its
   * `errors` only fill in from field-level interaction. The server re-validates
   * with the same schema and returns the same message keys, so without this
   * merge an invalid submission would re-render with no message anywhere.
   */
  const fieldError = (name: string, clientKey?: string) =>
    msg(serverErrors?.[name]?.[0] ?? clientKey)

  return (
    <form action={action} className="mt-8 max-w-[800px]" noValidate>
      {formError && (
        <p role="alert" className="mb-6 border-l-4 border-error bg-surface px-4 py-3">
          {t(formError as 'soldOut')}
        </p>
      )}
      <input type="hidden" {...register('ticketTypeId')} />
      <input type="hidden" {...register('quantity', { valueAsNumber: true })} />
      <input type="hidden" {...register('locale')} />
      <input type="hidden" {...register('currency')} />

      <fieldset className="border-0 p-0">
        <legend className="text-xl">{t('buyerSection')}</legend>

        <Field name="email" label={t('email')} hint={t('emailHint')} error={fieldError('email', errors.email?.message)}>
          {(a) => <input type="email" autoComplete="email" {...a} {...register('email')} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="firstName" label={t('firstName')} error={fieldError('firstName', errors.firstName?.message)}>
            {(a) => <input autoComplete="given-name" {...a} {...register('firstName')} />}
          </Field>
          <Field name="lastName" label={t('lastName')} error={fieldError('lastName', errors.lastName?.message)}>
            {(a) => <input autoComplete="family-name" {...a} {...register('lastName')} />}
          </Field>
        </div>

        <Field name="phone" label={t('phone')} error={fieldError('phone', errors.phone?.message)}>
          {(a) => <input type="tel" autoComplete="tel" {...a} {...register('phone')} />}
        </Field>
      </fieldset>

      <fieldset className="mt-8 border-0 p-0">
        <legend className="text-xl">{t('attendeesSection')}</legend>
        {fieldError('attendeeNames', errors.attendeeNames?.message) && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {fieldError('attendeeNames', errors.attendeeNames?.message)}
          </p>
        )}
        {Array.from({ length: quantity }, (_, i) => (
          <Field
            key={i}
            name={`attendeeNames-${i}`}
            label={t('attendeeLabel', { number: i + 1 })}
            error={msg(errors.attendeeNames?.[i]?.message)}
          >
            {(a) => <input {...a} {...register(`attendeeNames.${i}` as const)} />}
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
            <Field name="companyName" label={t('companyName')} error={fieldError('companyName', errors.companyName?.message)}>
              {(a) => <input {...a} {...register('companyName')} />}
            </Field>
            <Field name="nip" label={t('nip')} error={fieldError('nip', errors.nip?.message)}>
              {(a) => <input {...a} {...register('nip')} />}
            </Field>
            <Field name="invoiceAddress" label={t('invoiceAddress')} error={fieldError('invoiceAddress', errors.invoiceAddress?.message)}>
              {(a) => <input {...a} {...register('invoiceAddress')} />}
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
      {fieldError('acceptedTerms', errors.acceptedTerms?.message) && (
        <p role="alert" className="text-sm text-danger">
          {fieldError('acceptedTerms', errors.acceptedTerms?.message)}
        </p>
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

/**
 * A labelled field with its hint and error wired to the input.
 *
 * The wiring is the point. A wrapping <label> alone associates the caption
 * for a pointer user, but a screen reader still never hears the hint or the
 * error — so a blind buyer is told "invalid entry" with no idea which rule
 * they broke. `aria-describedby` reads both aloud, and `aria-invalid` is what
 * makes the field announce as erroneous at all.
 *
 * The input is a render prop so it receives the generated ids rather than the
 * caller having to keep two sets of strings in sync.
 */
function Field({
  name,
  label,
  hint,
  error,
  children,
}: {
  name: string
  label: string
  hint?: string
  error?: string
  children: (props: {
    id: string
    'aria-invalid': boolean | undefined
    'aria-describedby': string | undefined
    className: string
  }) => React.ReactNode
}) {
  const id = `f-${name}`
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="mt-4">
      <label htmlFor={id} className="block text-sm text-text-secondary">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-text-secondary">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        className: INPUT,
      })}
      {error && (
        // role=alert so the message is announced when it appears, rather
        // than only being found by someone already exploring the field.
        <p id={errorId} role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
