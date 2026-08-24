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

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  } catch (error) {
    // Best effort by design: never let an audit failure abort a refund,
    // an invitation, or an event change.
    console.error('[audit] failed to record entry', entry.action, error)
  }
}
