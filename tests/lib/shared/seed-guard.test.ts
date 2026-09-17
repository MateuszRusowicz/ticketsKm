import { describe, expect, it } from 'vitest'
import { adminSeedDecision, isLocalDatabase } from '@/lib/shared/seed-guard'

const LOCAL = 'postgresql://km:km@localhost:5432/km_dev'
const NEON = 'postgresql://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require'

describe('isLocalDatabase', () => {
  it('accepts the Docker Compose host', () => {
    expect(isLocalDatabase(LOCAL)).toBe(true)
  })

  it('accepts the loopback addresses CI uses', () => {
    expect(isLocalDatabase('postgresql://km:km@127.0.0.1:5432/km_test')).toBe(true)
    expect(isLocalDatabase('postgresql://km:km@[::1]:5432/km_test')).toBe(true)
  })

  it('rejects a Neon host', () => {
    expect(isLocalDatabase(NEON)).toBe(false)
  })

  it('rejects a host that merely contains "localhost"', () => {
    // The substring check this replaces would have called it local.
    expect(isLocalDatabase('postgresql://u:p@localhost.attacker.example/db')).toBe(false)
  })

  it('treats an unparseable string as remote', () => {
    expect(isLocalDatabase('not a url')).toBe(false)
  })
})

describe('adminSeedDecision', () => {
  it('seeds admins against a local database', () => {
    expect(adminSeedDecision({ connectionString: LOCAL, skipAdmins: false })).toEqual({
      action: 'seed',
    })
  })

  it('refuses to seed admins against a remote database', () => {
    const d = adminSeedDecision({ connectionString: NEON, skipAdmins: false })
    expect(d.action).toBe('refuse')
    // The message has to tell the operator what to do instead, or they will
    // reach for the nearest way around it.
    expect(d.action === 'refuse' && d.reason).toContain('SEED_SKIP_ADMINS=1')
  })

  it('skips admins on a remote database when the flag is set', () => {
    expect(adminSeedDecision({ connectionString: NEON, skipAdmins: true })).toEqual({
      action: 'skip',
    })
  })

  it('honours the flag locally too', () => {
    expect(adminSeedDecision({ connectionString: LOCAL, skipAdmins: true })).toEqual({
      action: 'skip',
    })
  })

  it('refuses when no connection string is set', () => {
    expect(adminSeedDecision({ connectionString: undefined, skipAdmins: false }).action).toBe(
      'refuse',
    )
  })
})
