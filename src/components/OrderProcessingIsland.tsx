'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

// Poll every 3 seconds. After 5 minutes, show the timeout message instead.
const POLL_INTERVAL_MS = 3_000
const TIMEOUT_MS = 5 * 60 * 1_000

export function OrderProcessingIsland() {
  const t = useTranslations('order')
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    const startedAt = Date.now()

    const interval = setInterval(() => {
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        clearInterval(interval)
        setTimedOut(true)
        return
      }
      // Hard reload — the server page re-renders with the updated band
      // once the webhook has processed the payment.
      window.location.reload()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [])

  return (
    <p className="prose-serif mt-4 text-text-secondary">
      {timedOut ? t('processing.timeoutBody') : t('processing.body')}
    </p>
  )
}
