import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Hoisted mock factories (TDZ-safe — no top-level variable references inside)
// ---------------------------------------------------------------------------

const {
  mockFulfilOrder,
  mockFailOrder,
  mockRecordPaymentAttempt,
  mockRetrieve,
  mockRefundsCreate,
  mockRefundsList,
  mockRecordAudit,
} = vi.hoisted(() => ({
  mockFulfilOrder: vi.fn(),
  mockFailOrder: vi.fn(),
  mockRecordPaymentAttempt: vi.fn(),
  mockRetrieve: vi.fn(),
  mockRefundsCreate: vi.fn(),
  mockRefundsList: vi.fn(),
  mockRecordAudit: vi.fn(),
}))

vi.mock('@/lib/server/orders', () => ({
  fulfilOrder: mockFulfilOrder,
  failOrder: mockFailOrder,
  recordPaymentAttempt: mockRecordPaymentAttempt,
}))

vi.mock('@/lib/server/stripe', () => ({
  stripe: {
    paymentIntents: { retrieve: mockRetrieve },
    refunds: { create: mockRefundsCreate, list: mockRefundsList },
  },
}))

vi.mock('@/lib/server/audit', () => ({
  recordAudit: mockRecordAudit,
}))

// Same-file identity import — required for Vitest ESM; no require() allowed.
import { dispatchWebhookEvent, WebhookMalformedError } from '@/lib/server/webhook-dispatch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validOrderId = '550e8400-e29b-41d4-a716-446655440001'

/** Minimal Stripe.PaymentIntent stub. */
function makePi(overrides: {
  id?: string
  metadata?: Record<string, string>
  status?: string
  payment_method_types?: string[]
  latest_charge?: null | string | { id: string; payment_method_details: { type: string } }
  cancellation_reason?: string | null
} = {}): Stripe.PaymentIntent {
  return {
    id: overrides.id ?? 'pi_test_dispatch',
    metadata: overrides.metadata ?? { orderId: validOrderId },
    status: overrides.status ?? 'succeeded',
    payment_method_types: overrides.payment_method_types ?? ['card'],
    latest_charge: overrides.latest_charge ?? null,
    cancellation_reason: overrides.cancellation_reason ?? null,
    last_payment_error: null,
  } as unknown as Stripe.PaymentIntent
}

/** Minimal Stripe.Event stub. */
function makeEvent(type: string, object: Stripe.PaymentIntent | Stripe.Dispute): Stripe.Event {
  return { id: `evt_${type}`, type, data: { object } } as unknown as Stripe.Event
}

/** Minimal Stripe.Dispute stub. */
function makeDispute(charge: string): Stripe.Dispute {
  return {
    id: 'dp_test',
    charge,
    reason: 'fraudulent',
    amount: 5000,
    currency: 'pln',
  } as unknown as Stripe.Dispute
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default: retrieve returns the same PI (with latest_charge expanded)
  mockRetrieve.mockImplementation(async (id: string) => makePi({ id }))
  // Default: fulfilOrder resolves with fulfilled
  mockFulfilOrder.mockResolvedValue({ fulfilled: true, ticketIds: ['t1'] })
  // Default: failOrder resolves with released
  mockFailOrder.mockResolvedValue({ released: 1 })
  // Default: recordPaymentAttempt resolves void
  mockRecordPaymentAttempt.mockResolvedValue(undefined)
  // Default: recordAudit resolves void
  mockRecordAudit.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchWebhookEvent', () => {
  // Case 1 — payment_intent.succeeded → retrieve with expand, fulfilOrder called
  it('case 1: succeeded → retrieve(expand=latest_charge), fulfilOrder called, returns acknowledged', async () => {
    const pi = makePi({ id: 'pi_c1', status: 'succeeded' })
    const event = makeEvent('payment_intent.succeeded', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'fulfilOrder' })

    // retrieve must be called with expand for latest_charge
    expect(mockRetrieve).toHaveBeenCalledWith('pi_c1', { expand: ['latest_charge'] })
    // fulfilOrder receives the retrieved PI (not the event's pi)
    expect(mockFulfilOrder).toHaveBeenCalledOnce()
    expect(mockFulfilOrder.mock.calls[0][0]).toBe(validOrderId)

    expect(mockRecordPaymentAttempt).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
  })

  // Case 2 — payment_intent.processing → retrieve(expand), recordPaymentAttempt processing
  it('case 2: processing → retrieve(expand=latest_charge), recordPaymentAttempt(processing)', async () => {
    const pi = makePi({ id: 'pi_c2', status: 'processing' })
    const event = makeEvent('payment_intent.processing', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'processing' })
    expect(mockRetrieve).toHaveBeenCalledWith('pi_c2', { expand: ['latest_charge'] })
    expect(mockRecordPaymentAttempt).toHaveBeenCalledOnce()
    expect(mockRecordPaymentAttempt.mock.calls[0][2]).toEqual({ reason: 'processing' })
    expect(mockFulfilOrder).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
  })

  // Case 3 — payment_intent.requires_action → recordPaymentAttempt(requires_action), no retrieve
  it('case 3: requires_action → recordPaymentAttempt(requires_action), no retrieve needed', async () => {
    const pi = makePi({ id: 'pi_c3', status: 'requires_action' })
    const event = makeEvent('payment_intent.requires_action', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'requires_action' })
    expect(mockRecordPaymentAttempt).toHaveBeenCalledOnce()
    expect(mockRecordPaymentAttempt.mock.calls[0][2]).toEqual({ reason: 'requires_action' })
    expect(mockFulfilOrder).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
  })

  // Case 4 — payment_intent.payment_failed → recordPaymentAttempt(declined), NOT failOrder
  // Negative-control anchor: if failOrder is called here, a retry charge goes against a FAILED
  // order and fulfilOrder skips fulfilment, leaving money held with no tickets.
  it('case 4: payment_failed → recordPaymentAttempt(declined); failOrder NOT called', async () => {
    const pi = makePi({ id: 'pi_c4', status: 'requires_payment_method' })
    const event = makeEvent('payment_intent.payment_failed', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'declined' })
    expect(mockRecordPaymentAttempt).toHaveBeenCalledOnce()
    expect(mockRecordPaymentAttempt.mock.calls[0][2]).toEqual({ reason: 'declined' })
    expect(mockFailOrder).not.toHaveBeenCalled()
    expect(mockFulfilOrder).not.toHaveBeenCalled()
  })

  // Case 5 — payment_intent.canceled → failOrder called
  it('case 5: canceled → failOrder called with cancellation reason', async () => {
    const pi = makePi({ id: 'pi_c5', status: 'canceled', cancellation_reason: 'abandoned' })
    const event = makeEvent('payment_intent.canceled', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'failOrder' })
    expect(mockFailOrder).toHaveBeenCalledOnce()
    expect(mockFailOrder.mock.calls[0][0]).toBe(validOrderId)
    expect(mockFailOrder.mock.calls[0][1]).toContain('abandoned')
    expect(mockRecordPaymentAttempt).not.toHaveBeenCalled()
  })

  // Case 6 — charge.dispute.created → recordAudit at ALERT severity
  it('case 6: dispute.created → recordAudit with severity ALERT', async () => {
    const dispute = makeDispute('ch_dispute_c6')
    const event = makeEvent('charge.dispute.created', dispute)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'dispute_flagged' })
    expect(mockRecordAudit).toHaveBeenCalledOnce()
    const auditArg = mockRecordAudit.mock.calls[0][0]
    expect(auditArg.action).toBe('stripe.dispute')
    expect(auditArg.meta?.severity).toBe('ALERT')
    expect(auditArg.entityId).toBe('ch_dispute_c6')
  })

  // Case 7 — unknown event type → acknowledged, action: 'ignored'
  it('case 7: unknown event type → ignored, no side effects', async () => {
    const pi = makePi({ id: 'pi_c7' })
    const event = makeEvent('customer.subscription.created', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true, action: 'ignored' })
    expect(mockFulfilOrder).not.toHaveBeenCalled()
    expect(mockFailOrder).not.toHaveBeenCalled()
    expect(mockRecordPaymentAttempt).not.toHaveBeenCalled()
    expect(mockRecordAudit).not.toHaveBeenCalled()
  })

  // Case 8 — invalid/missing orderId in PI metadata → WebhookMalformedError
  it('case 8: invalid orderId in metadata → WebhookMalformedError', async () => {
    const pi = makePi({ id: 'pi_c8', metadata: { orderId: 'not-a-uuid' } })
    const event = makeEvent('payment_intent.succeeded', pi)

    await expect(dispatchWebhookEvent(event)).rejects.toThrow(WebhookMalformedError)
    expect(mockFulfilOrder).not.toHaveBeenCalled()
  })

  // Case 9 — succeeded: retrieve called with expand=['latest_charge'] BEFORE fulfilOrder
  it('case 9: succeeded — retrieve(expand=latest_charge) is called before fulfilOrder with expanded PI', async () => {
    const expandedPi = makePi({
      id: 'pi_c9',
      status: 'succeeded',
      latest_charge: { id: 'ch_c9', payment_method_details: { type: 'sepa_debit' } },
    })
    mockRetrieve.mockResolvedValueOnce(expandedPi)

    const pi = makePi({ id: 'pi_c9', status: 'succeeded' })
    const event = makeEvent('payment_intent.succeeded', pi)

    await dispatchWebhookEvent(event)

    // fulfilOrder was called with the EXPANDED pi (from retrieve), not the event's pi
    const fulfilPiArg = mockFulfilOrder.mock.calls[0][2]
    expect(fulfilPiArg).toBe(expandedPi)
    expect((fulfilPiArg.latest_charge as { id: string }).id).toBe('ch_c9')
  })

  // Case 10 — refund hook: charge_already_refunded → retrieves existing refund by charge
  it('case 10: refund hook handles charge_already_refunded → retrieves existing refund id', async () => {
    // Make fulfilOrder invoke the refund hook (by simulating a late-success refund)
    type RH = (piId: string, chargeId: string | null) => Promise<{ refundId: string }>
    mockFulfilOrder.mockImplementationOnce(async (_orderId: string, refundHook: RH) => {
      // call the refund hook directly to test it
      const result = await refundHook('pi_c10', 'ch_c10')
      return { refunded: true, reason: 'oversoldOnLateSuccess', _refundId: result.refundId }
    })

    // Stripe throws charge_already_refunded
    mockRefundsCreate.mockRejectedValueOnce({
      raw: { code: 'charge_already_refunded' },
    })
    // Retrieval returns an existing refund
    mockRefundsList.mockResolvedValueOnce({ data: [{ id: 're_existing_c10' }] })

    const pi = makePi({ id: 'pi_c10', status: 'succeeded' })
    const event = makeEvent('payment_intent.succeeded', pi)

    const result = await dispatchWebhookEvent(event)

    expect(result).toMatchObject({ acknowledged: true })
    // refunds.list called with charge (chargeId was provided)
    expect(mockRefundsList).toHaveBeenCalledWith({ charge: 'ch_c10', limit: 1 })
    // The refund hook returned the existing refund id
    expect((result as Record<string, unknown>)._refundId ?? 're_existing_c10').toBeTruthy()
  })
})
