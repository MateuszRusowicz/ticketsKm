import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    hookTimeout: 30_000,

    // Test files share one Postgres database and TRUNCATE overlapping
    // tables. Vitest runs FILES in parallel by default, which would let one
    // file wipe AdminUser while another is mid-assertion. That is a
    // certainty from the moment there are two such files, so it is settled
    // here rather than after the first flake.
    //
    // Vitest 4 removed `poolOptions`; these are top-level options now.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      // fileURLToPath rather than __dirname: this config is an ES module.
      // The .mts extension is what makes that unambiguous to Vite.
      '@': fileURLToPath(new URL('./src', import.meta.url)),

      // `server-only` throws on import unless resolved under React's
      // "react-server" condition. Vitest does not use that condition, so
      // every server module would fail to import. Stubbing it here is
      // scoped to tests; the real package still guards the Next.js build.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
})
