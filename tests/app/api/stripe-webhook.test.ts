import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { db } from '@/lib/server/db'

// ---------------------------------------------------------------------------
// Hoisted mock factories (TDZ-safe)
// ---------------------------------------------------------------------------

const { mockConstructEvent, mockDispatch, MockWebhookMalformedError } = vi.hoisted(() => {
  // Define the error class inside hoisted so both the mock module and test
  // teardown share the exact same class reference (instanceof works correctly).
  class MockWebhookMalformedError extends Error {
    constructor(reason: string) {
      super(reason)
      this.name = 'WebhookMalformedError'
    }
  }
  return {
    mockConstructEvent: vi.fn<() => Stripe.Event>(),
    mockDispatch: vi.fn(),
    MockWebhookMalformedError,
  }
})

vi.mock('@/lib/server/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: mockConstructEvent },
  },
}))

vi.mock('@/lib/server/webhook-dispatch', () => ({
  dispatchWebhookEvent: mockDispatch,
  WebhookMalformedError: MockWebhookMalformedError,
}))

// Same-file identity import — no require() in Vitest ESM.
import { POST } from '@/app/api/webhooks/stripe/route'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_EVENT_ID = 'evt_test_webhook_001'
const TEST_ORDER_ID = '550e8400-e29b-41d4-a716-446655440099'

/** Pretty-printed body — the negative control for request.text() depends on this. */
const PRETTY_BODY = JSON.stringify(
  { id: TEST_EVENT_ID, type: 'payment_intent.succeeded', data: { object: {} } },
  null,
  2,
)

const TEST_EVENT = {
  id: TEST_EVENT_ID,
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test', metadata: { orderId: TEST_ORDER_ID } } },
} as unknown as Stripe.Event

function makeRequest(body: string, sig?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'text/plain' }
  if (sig !== undefined) headers['stripe-signature'] = sig
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "StripeWebhookEvent", "AuditLog" RESTART IDENTITY CASCADE',
  )
  mockConstructEvent.mockReset()
  mockDispatch.mockReset()
  // Default: signature verification succeeds
  mockConstructEvent.mockReturnValue(TEST_EVENT)
  // Default: dispatch succeeds
  mockDispatch.mockResolvedValue({ acknowledged: true, action: 'fulfilOrder', detail: '{}' })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/stripe', () => {
  // Case 1 — happy path: signature OK → dispatch called → processedAt set → 200
  it('case 1: happy path — dispatch called, processedAt set, attemptCount=1, returns 200', async () => {
    const res = await POST(makeRequest(PRETTY_BODY, 'sig_v1_ok'))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ acknowledged: true })

    expect(mockConstructEvent).toHaveBeenCalledOnce()
    // Negative-control anchor for raw body: the exact pretty-printed bytes must reach constructEvent.
    expect(mockConstructEvent).toHaveBeenCalledWith(PRETTY_BODY, 'sig_v1_ok', expect.any(String))

    expect(mockDispatch).toHaveBeenCalledOnce()
    expect(mockDispatch).toHaveBeenCalledWith(TEST_EVENT)

    const row = await db.stripeWebhookEvent.findUnique({
      where: { stripeEventId: TEST_EVENT_ID },
    })
    expect(row).not.toBeNull()
    expect(row!.processedAt).not.toBeNull()
    expect(row!.attemptCount).toBe(1)
    expect(row!.error).toBeNull()
    expect(row!.deadLettered).toBe(false)
  })

  // Case 2 — NEGATIVE CONTROL: forged signature → 400, no ledger entry, no dispatch
  it('case 2: forged signature → 400, no ledger row, no dispatch', async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature for payload.')
    })

    const res = await POST(makeRequest(PRETTY_BODY, 'sig_forged'))

    expect(res.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(await db.stripeWebhookEvent.count()).toBe(0)
  })

  // Case 3 — duplicate delivery (processedAt already set) → 200, dispatch NOT called
  it('case 3: duplicate delivery (processedAt set) → 200, dispatch not called again', async () => {
    // Pre-insert the row as already processed
    await db.stripeWebhookEvent.create({
      data: {
        stripeEventId: TEST_EVENT_ID,
        type: TEST_EVENT.type,
        processedAt: new Date(),
        attemptCount: 1,
      },
    })

    const res = await POST(makeRequest(PRETTY_BODY, 'sig_v1_dup'))

    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  // Case 4 — second delivery after first succeeds → idempotency guard fires, dispatch once total
  it('case 4: second delivery after first success → processedAt guard, dispatch called once', async () => {
    // First delivery: succeeds
    const res1 = await POST(makeRequest(PRETTY_BODY, 'sig_v1_a'))
    expect(res1.status).toBe(200)
    expect(mockDispatch).toHaveBeenCalledOnce()

    // Second delivery with the same event id: dispatch must not run again
    mockDispatch.mockClear()
    const res2 = await POST(makeRequest(PRETTY_BODY, 'sig_v1_b'))
    expect(res2.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()

    // processedAt remains set from first delivery
    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: TEST_EVENT_ID } })
    expect(row!.processedAt).not.toBeNull()
  })

  // Case 5 — first attempt fails; retry succeeds → dispatch called twice, attemptCount=2
  it('case 5: first attempt fails → error recorded; retry succeeds → processedAt set, attemptCount=2', async () => {
    // First attempt: dispatch throws a non-WebhookMalformedError
    mockDispatch.mockRejectedValueOnce(new Error('Stripe network timeout'))

    // The route re-throws non-WebhookMalformedError errors (Next.js catches and returns 500
    // in production; in tests the promise rejects).
    await expect(POST(makeRequest(PRETTY_BODY, 'sig_v1_fail'))).rejects.toThrow(
      'Stripe network timeout',
    )

    // First attempt left the row with processedAt=NULL and error recorded
    const row1 = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: TEST_EVENT_ID } })
    expect(row1).not.toBeNull()
    expect(row1!.processedAt).toBeNull()
    expect(row1!.attemptCount).toBe(1)
    expect(row1!.error).toBe('Stripe network timeout')

    // Second attempt: dispatch succeeds
    const res2 = await POST(makeRequest(PRETTY_BODY, 'sig_v1_retry'))
    expect(res2.status).toBe(200)

    const row2 = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: TEST_EVENT_ID } })
    expect(row2!.processedAt).not.toBeNull()
    expect(row2!.attemptCount).toBe(2)

    expect(mockDispatch).toHaveBeenCalledTimes(2)
  })

  // Case 6 — dead-letter: attemptCount at limit → deadLettered=true, ALERT audit, 200
  it('case 6: attemptCount=WEBHOOK_MAX_ATTEMPTS → dead-lettered, ALERT audit, 200', async () => {
    const maxAttempts = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '8', 10)

    // Pre-insert with count at the limit
    await db.stripeWebhookEvent.create({
      data: {
        stripeEventId: TEST_EVENT_ID,
        type: TEST_EVENT.type,
        attemptCount: maxAttempts,
        processedAt: null,
      },
    })

    const res = await POST(makeRequest(PRETTY_BODY, 'sig_v1_dead'))

    expect(res.status).toBe(200)
    expect(mockDispatch).not.toHaveBeenCalled()

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: TEST_EVENT_ID } })
    expect(row!.deadLettered).toBe(true)

    const audit = await db.auditLog.findFirst({
      where: { action: 'stripe.webhook_dead_lettered', entityId: TEST_EVENT_ID },
    })
    expect(audit).not.toBeNull()
    expect((audit!.meta as Record<string, unknown>).severity).toBe('ALERT')
  })

  // Case 7 — WebhookMalformedError → 400, processedAt set (prevent retry), error populated
  it('case 7: WebhookMalformedError → 400, processedAt set to prevent retry, error logged', async () => {
    mockDispatch.mockRejectedValueOnce(
      new MockWebhookMalformedError('orderId is not a valid UUID'),
    )

    const res = await POST(makeRequest(PRETTY_BODY, 'sig_v1_bad'))

    expect(res.status).toBe(400)

    const row = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId: TEST_EVENT_ID } })
    expect(row).not.toBeNull()
    // processedAt is set so Stripe does not retry a permanently malformed event
    expect(row!.processedAt).not.toBeNull()
    expect(row!.error).toBe('orderId is not a valid UUID')
  })

  // Case 8 — missing stripe-signature → 400, no DB touched, no constructEvent call
  it('case 8: missing stripe-signature header → 400 immediately, no DB, no constructEvent', async () => {
    const res = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: PRETTY_BODY,
      }),
    )

    expect(res.status).toBe(400)
    expect(mockConstructEvent).not.toHaveBeenCalled()
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(await db.stripeWebhookEvent.count()).toBe(0)
  })
})
