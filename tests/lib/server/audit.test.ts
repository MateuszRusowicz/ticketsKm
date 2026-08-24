import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/server/db'
import { recordAudit } from '@/lib/server/audit'

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "AdminUser" RESTART IDENTITY CASCADE')
})

describe('recordAudit', () => {
  it('writes an entry with its actor', async () => {
    const admin = await db.adminUser.create({
      data: { email: 'a@example.com', name: 'A', role: 'ADMIN', passwordHash: 'x' },
    })

    await recordAudit({
      actorId: admin.id,
      action: 'event.create',
      entityType: 'Event',
      entityId: 'evt-1',
      meta: { slug: 'test' },
    })

    const [entry] = await db.auditLog.findMany()
    expect(entry.action).toBe('event.create')
    expect(entry.actorId).toBe(admin.id)
    expect(entry.meta).toEqual({ slug: 'test' })
  })

  it('accepts a system entry with no actor', async () => {
    await recordAudit({ action: 'cron.release_holds', entityType: 'System', entityId: 'cron' })
    const [entry] = await db.auditLog.findMany()
    expect(entry.actorId).toBeNull()
  })

  it('never throws — a failed audit write must not break the operation', async () => {
    await expect(
      recordAudit({
        actorId: '00000000-0000-0000-0000-000000000000', // no such admin
        action: 'x',
        entityType: 'Y',
        entityId: 'z',
      }),
    ).resolves.toBeUndefined()
  })
})
