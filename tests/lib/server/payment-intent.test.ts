import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/server/db'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any import that pulls stripe/payment-
// methods, because vi.hoisted lifts the factory to the top of the compiled
// file, before all ES imports.
// ---------------------------------------------------------------------------

const { paymentIntentsCreate, paymentIntentsRetrieve, mockStripeAmount, computeAllowedPaymentMethodsMock } =
  vi.hoisted(() => ({
    paymentIntentsCreate: vi.fn(),
    paymentIntentsRetrieve: vi.fn(),
    mockStripeAmount: vi.fn((o: { total: number }) => o.total),
    computeAllowedPaymentMethodsMock: vi.fn(async () => ['card', 'blik', 'p24'] as string[]),
  }))

vi.mock('@/lib/server/stripe', () => ({
  stripe: {
    paymentIntents: {
      create: paymentIntentsCreate,
      retrieve: paymentIntentsRetrieve,
    },
  },
  stripeCurrency: (c: 'PLN' | 'EUR') => (c === 'PLN' ? 'pln' : 'eur'),
  stripeAmount: mockStripeAmount,
}))

vi.mock('@/lib/server/payment-methods', () => ({
  computeAllowedPaymentMethods: computeAllowedPaymentMethodsMock,
}))

// Import under-test AFTER vi.mock calls
import { createPaymentIntent, PaymentIntentReuseError } from '@/lib/server/payment-intent'

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function makeOrder(
  overrides: {
    currency?: 'PLN' | 'EUR'
    total?: number
    status?: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED'
    stripePaymentIntentId?: string | null
  } = {},
) {
  const order = await db.order.create({
    data: {
      reference: `TEST-PI-${crypto.randomUUID()}`,
      kind: 'PURCHASE',
      email: 'buyer@example.test',
      firstName: 'Test',
      lastName: 'Buyer',
      locale: 'pl',
      currency: overrides.currency ?? 'PLN',
      subtotal: overrides.total ?? 5000,
      discount: 0,
      total: overrides.total ?? 5000,
      status: overrides.status ?? 'PENDING',
      attendeeNames: [],
      holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      stripePaymentIntentId: overrides.stripePaymentIntentId ?? null,
    },
    select: { id: true },
  })
  return order.id
}

function makePi(id = 'pi_test_default', clientSecret = 'cs_test_default') {
  return { id, client_secret: clientSecret }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditLog", "OrderItem", "Order", "TicketType",
                   "EventTranslation", "Event", "Venue"
    RESTART IDENTITY CASCADE
  `)
  await db.$executeRawUnsafe('ALTER SEQUENCE "order_reference_seq" RESTART')

  paymentIntentsCreate.mockReset()
  paymentIntentsRetrieve.mockReset()
  mockStripeAmount.mockReset()
  computeAllowedPaymentMethodsMock.mockReset()

  // Default implementations
  paymentIntentsCreate.mockResolvedValue(makePi())
  paymentIntentsRetrieve.mockResolvedValue(makePi('pi_test_retrieved', 'cs_test_retrieved'))
  mockStripeAmount.mockImplementation((o: { total: number }) => o.total)
  computeAllowedPaymentMethodsMock.mockResolvedValue(['card', 'blik', 'p24'])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPaymentIntent', () => {
  // Case 1 — Happy first call
  it('creates a PI and sets BOTH stripePaymentIntentId and paymentIntentStatus in the same UPDATE', async () => {
    const orderId = await makeOrder()

    const result = await createPaymentIntent(orderId)

    expect(paymentIntentsCreate).toHaveBeenCalledTimes(1)
    expect(paymentIntentsRetrieve).not.toHaveBeenCalled()
    expect(result.clientSecret).toBe('cs_test_default')
    expect(result.paymentIntentId).toBe('pi_test_default')
    expect(result.publishableKey).toMatch(/^pk_test_/)

    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { stripePaymentIntentId: true, paymentIntentStatus: true },
    })
    // Both fields set atomically in one UPDATE
    expect(order.stripePaymentIntentId).toBe('pi_test_default')
    expect(order.paymentIntentStatus).toBe('requires_confirmation')
  })

  // Case 2 — Second call: retrieve, not create
  it('retrieves an existing PI when the order already has stripePaymentIntentId', async () => {
    const orderId = await makeOrder({ stripePaymentIntentId: 'pi_already_set' })
    paymentIntentsRetrieve.mockResolvedValue(makePi('pi_already_set', 'cs_already_set'))

    const result = await createPaymentIntent(orderId)

    expect(paymentIntentsCreate).not.toHaveBeenCalled()
    expect(paymentIntentsRetrieve).toHaveBeenCalledWith('pi_already_set')
    expect(result.clientSecret).toBe('cs_already_set')
    expect(result.paymentIntentId).toBe('pi_already_set')
  })

  // Case 3 — Concurrent: Promise.all with distinct mock ids triggers the collision guard
  it('throws a collision error when two concurrent calls create different PI ids', async () => {
    const orderId = await makeOrder()

    let callIndex = 0
    paymentIntentsCreate.mockImplementation(async () => {
      const n = ++callIndex
      return makePi(`pi_conc_${n}`, `cs_conc_${n}`)
    })

    // One succeeds, one throws the collision error
    await expect(
      Promise.all([createPaymentIntent(orderId), createPaymentIntent(orderId)]),
    ).rejects.toThrow(/idempotency-key collision/i)

    // Exactly one PI has been written to the DB
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { stripePaymentIntentId: true, paymentIntentStatus: true },
    })
    expect(order.stripePaymentIntentId).toMatch(/^pi_conc_/)
    expect(order.paymentIntentStatus).toBe('requires_confirmation')
  })

  // Case 4 — 409 idempotency_key_in_use: backoff, re-read, retry create
  it('retries create on idempotency_key_in_use and succeeds', async () => {
    const orderId = await makeOrder()

    let attempt = 0
    paymentIntentsCreate.mockImplementation(async () => {
      attempt++
      if (attempt === 1) {
        const err = Object.assign(new Error('idempotency key in use'), {
          raw: { code: 'idempotency_key_in_use' },
        })
        throw err
      }
      return makePi('pi_retried', 'cs_retried')
    })

    const result = await createPaymentIntent(orderId)

    expect(attempt).toBe(2)
    expect(result.paymentIntentId).toBe('pi_retried')
    expect(result.clientSecret).toBe('cs_retried')
  }, 3000)

  // Case 5 — Order not PENDING (e.g. EXPIRED)
  it('throws PaymentIntentReuseError(notPending) for a non-PENDING order', async () => {
    const orderId = await makeOrder({ status: 'EXPIRED' })

    await expect(createPaymentIntent(orderId)).rejects.toMatchObject({
      name: 'PaymentIntentReuseError',
      message: expect.stringContaining('notPending'),
    })
    expect(paymentIntentsCreate).not.toHaveBeenCalled()
  })

  // Case 6 — Order PAID
  it('throws PaymentIntentReuseError(alreadyPaid) for a PAID order', async () => {
    const orderId = await makeOrder({ status: 'PAID' })

    await expect(createPaymentIntent(orderId)).rejects.toMatchObject({
      name: 'PaymentIntentReuseError',
      message: expect.stringContaining('alreadyPaid'),
    })
    expect(paymentIntentsCreate).not.toHaveBeenCalled()
  })

  // Case 7 — Order does not exist → Prisma P2025
  it('throws when the order does not exist', async () => {
    await expect(
      createPaymentIntent('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow()
  })

  // Case 8 — Amount comes from DB, not from payload
  it('uses the amount from the DB even if total was mutated after order creation', async () => {
    const orderId = await makeOrder({ total: 5000 })
    // Simulate a price change between createOrder and createPaymentIntent
    await db.order.update({ where: { id: orderId }, data: { total: 7500 } })

    await createPaymentIntent(orderId)

    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 7500 }),
      expect.any(Object),
    )
  })

  // Case 9 — EUR currency → create called with currency: 'eur'
  it('passes currency eur to create for a EUR order', async () => {
    const orderId = await makeOrder({ currency: 'EUR' })

    await createPaymentIntent(orderId)

    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'eur' }),
      expect.any(Object),
    )
  })

  // Case 10 — Zero-amount refusal: stripeAmount throws
  it('propagates the error when stripeAmount throws for a zero-total order', async () => {
    const orderId = await makeOrder({ total: 0 })
    mockStripeAmount.mockImplementationOnce(() => {
      throw new Error('stripeAmount: zero-amount order')
    })

    await expect(createPaymentIntent(orderId)).rejects.toThrow(/zero-amount/i)
    expect(paymentIntentsCreate).not.toHaveBeenCalled()
  })

  // Case 11 — payment_method_types comes from computeAllowedPaymentMethods
  it('passes payment_method_types from computeAllowedPaymentMethods to create', async () => {
    const orderId = await makeOrder()
    computeAllowedPaymentMethodsMock.mockResolvedValueOnce(['card', 'sepa_debit'])

    await createPaymentIntent(orderId)

    expect(paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method_types: ['card', 'sepa_debit'] }),
      expect.any(Object),
    )
  })

  // Case: PaymentIntentReuseError is exportable and has the correct name
  it('PaymentIntentReuseError has name PaymentIntentReuseError', () => {
    const err = new PaymentIntentReuseError('notPending')
    expect(err.name).toBe('PaymentIntentReuseError')
    expect(err.message).toBe('notPending')
    expect(err).toBeInstanceOf(Error)
  })
})
