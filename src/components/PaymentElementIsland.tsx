'use client'

import { useActionState } from 'react'
import { useState } from 'react'
import { loadStripe, type Appearance } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js'
import { useTranslations } from 'next-intl'
import {
  extendHoldAction,
  type ExtendHoldState,
} from '@/app/(shop)/[locale]/order/[reference]/actions'

// Module-scoped so loadStripe is called at most once per page load.
// Lazily initialised on the first successful extendHoldAction response,
// because the publishable key arrives from the server action — not from a
// NEXT_PUBLIC_ variable.
let stripePromise: ReturnType<typeof loadStripe> | null = null
function getStripe(publishableKey: string) {
  return (stripePromise ??= loadStripe(publishableKey))
}


/**
 * Theme for Stripe's Payment Element, which renders in an iframe and ignores
 * our CSS. Values mirror the tokens in globals.css (plan/10-design-system.md
 * §6); an unthemed Element looks like a foreign object in the middle of the
 * checkout. System fonts only — loading a web font into Stripe's iframe would
 * fetch it from a third party, which §3 of the design system rules out.
 */
const APPEARANCE: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#CC1216',
    colorBackground: '#FFFFFF',
    colorText: '#1A1A1A',
    colorTextSecondary: '#555454',
    colorDanger: '#CC1216',
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontSizeBase: '16px',
    borderRadius: '2px',
    spacingUnit: '4px',
  },
  rules: {
    // #757575, not the decorative #E0E0E0: Stripe's fields are form controls
    // and fall under the same 3:1 non-text contrast rule as ours.
    '.Input': { border: '1px solid #757575', boxShadow: 'none' },
    '.Input:focus': { outline: '2px solid #CC1216', outlineOffset: '2px', boxShadow: 'none' },
    '.Label': { fontWeight: '500', color: '#555454' },
    '.Tab': { border: '1px solid #949494', boxShadow: 'none' },
    '.Tab--selected': { borderColor: '#CC1216', boxShadow: '0 0 0 1px #CC1216' },
  },
}

type Props = {
  reference: string
  accessToken: string
  locale: string
}

export function PaymentElementIsland({ reference, accessToken, locale }: Props) {
  const t = useTranslations('order')
  const [state, dispatch, isPending] = useActionState<ExtendHoldState, FormData>(
    extendHoldAction,
    {},
  )

  const hasSecret = 'clientSecret' in state
  const hasError = 'errors' in state
  const errorKey = hasError ? state.errors._form[0] : null

  if (hasSecret) {
    const stripe = getStripe(state.publishableKey)
    const returnUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/${locale}/order/${reference}?t=${accessToken}`
    return (
      <div className="mt-8">
        <Elements stripe={stripe} options={{ clientSecret: state.clientSecret, appearance: APPEARANCE }}>
          <StripeCheckoutForm returnUrl={returnUrl} />
        </Elements>
      </div>
    )
  }

  return (
    <form action={dispatch} className="mt-8">
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="accessToken" value={accessToken} />

      {hasError && errorKey && (
        <p role="alert" className="mb-3 text-error">
          {t(`holding.${errorKey}` as 'holding.notFound')}
        </p>
      )}

      <button type="submit" disabled={isPending} className="btn btn-primary w-full sm:w-auto">
        {isPending ? t('holding.paymentLoading') : t('holding.payButton')}
      </button>
    </form>
  )
}

// Inner component: lives inside <Elements> so useStripe/useElements are wired.
function StripeCheckoutForm({ returnUrl }: { returnUrl: string }) {
  const t = useTranslations('order')
  const stripe = useStripe()
  const elements = useElements()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setSubmitting(true)
    setError(null)

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    })

    // If confirmPayment does not redirect, it returned an error.
    if (stripeError) {
      setError(stripeError.message ?? t('holding.paymentError'))
    }
    setSubmitting(false)
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />

      {error && (
        <p role="alert" className="mt-3 text-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !stripe}
        className="btn btn-primary mt-6 w-full sm:w-auto"
      >
        {submitting ? t('holding.paymentLoading') : t('holding.payButton')}
      </button>
    </form>
  )
}
