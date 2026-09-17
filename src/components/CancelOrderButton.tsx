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
    <form action={action} className="mt-4">
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="accessToken" value={accessToken} />

      {failed && (
        <p role="alert" className="mb-3 text-error">
          {notFoundLabel}
        </p>
      )}

      <button type="submit" className="btn btn-secondary w-full sm:w-auto">
        {label}
      </button>
    </form>
  )
}
