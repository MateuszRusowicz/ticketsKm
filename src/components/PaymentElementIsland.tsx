'use client'

import { useActionState } from 'react'
import { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
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
        <Elements stripe={stripe} options={{ clientSecret: state.clientSecret }}>
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

      <button
        type="submit"
        disabled={isPending}
        className="min-h-[44px] bg-accent px-6 text-base text-white hover:opacity-90 disabled:opacity-50"
      >
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
        className="mt-4 min-h-[44px] bg-accent px-6 text-base text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? t('holding.paymentLoading') : t('holding.payButton')}
      </button>
    </form>
  )
}
