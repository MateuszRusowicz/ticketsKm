import 'server-only'
import type { Prisma } from '@/generated/prisma/client'
import { db } from './db'

export type AuditEntry = {
  actorId?: string | null
  action: string
  entityType: string
  entityId: string
  meta?: Record<string, unknown>
}

/**
 * Records an audit entry.
 *
 * Two deliberately different failure modes:
 *
 * - **Standalone** (no `client`): best effort. An audit failure must never
 *   abort a refund, an invitation, or an event change, so the error is
 *   logged and swallowed.
 *
 * - **Transactional** (a `client` is passed): errors propagate. Swallowing
 *   here would be a lie — a failed statement aborts the enclosing Postgres
 *   transaction (25P02) whether or not JavaScript catches it, so every later
 *   statement and the COMMIT fail regardless. Pretending otherwise turns a
 *   clear error into a confusing one at commit time. Where the audit row is
 *   part of the paper trail for the write itself, as with order creation,
 *   all-or-nothing is also the behaviour you want.
 */
export async function recordAudit(
  entry: AuditEntry,
  client?: Prisma.TransactionClient,
): Promise<void> {
  const data = {
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
  }

  if (client) {
    await client.auditLog.create({ data })
    return
  }

  try {
    await db.auditLog.create({ data })
  } catch (error) {
    console.error('[audit] failed to record entry', entry.action, error)
  }
}
