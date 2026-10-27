import { describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'
import { emailFulfilledOrder } from '@/lib/server/email'

describe('emailFulfilledOrder', () => {
  it('returns { sent: false, reason: disabled } when EMAIL_ENABLED is not set', async () => {
    const findUniqueSpy = vi.spyOn(db.order, 'findUnique')

    const result = await emailFulfilledOrder('some-order-id')

    expect(result).toEqual({ sent: false, reason: 'disabled' })
    // Must not hit the database when the gate is closed
    expect(findUniqueSpy).not.toHaveBeenCalled()

    findUniqueSpy.mockRestore()
  })

  it.todo(
    'Plan 08: EMAIL_ENABLED=true → sends email and sets Order.emailSentAt',
  )

  it.todo(
    'Plan 08 idempotency: Order.emailSentAt already set → returns { sent: false, reason: alreadySent } without calling Resend',
  )
})
