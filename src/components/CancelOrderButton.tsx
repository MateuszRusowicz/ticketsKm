'use client'

import { useActionState } from 'react'
import { cancelOrderAction, type CancelState } from '@/app/(shop)/[locale]/order/[reference]/actions'

type Props = {
  reference: string
  accessToken: string
  label: string
  notFoundLabel: string
}

export function CancelOrderButton({ reference, accessToken, label, notFoundLabel }: Props) {
  const [state, action] = useActionState<CancelState, FormData>(cancelOrderAction, {})
  const failed = 'errors' in state

  return (
    <form action={action} className="mt-8">
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="accessToken" value={accessToken} />

      {failed && (
        <p role="alert" className="mb-3 text-error">
          {notFoundLabel}
        </p>
      )}

      <button type="submit" className="min-h-[44px] border border-border px-4 py-2 underline">
        {label}
      </button>
    </form>
  )
}
