import { execSync } from 'node:child_process'
import { beforeAll } from 'vitest'

// Applies migrations to the test database once per run. `migrate deploy`
// is idempotent, so repeated runs are cheap. `pnpm exec` uses the Prisma
// already installed rather than re-resolving it from the registry, and
// because vitest.config.mts sets fileParallelism: false this executes
// exactly once instead of once per worker.
beforeAll(() => {
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env },
  })
})
