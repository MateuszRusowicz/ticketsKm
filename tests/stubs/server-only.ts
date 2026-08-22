// The real `server-only` package throws on import unless resolved under
// React's "react-server" condition, which Vitest does not use. Tests
// exercise server modules directly, so it is aliased to this no-op in
// vitest.config.mts. The guarantee still holds where it matters: the
// Next.js build resolves the real package and fails if a server module
// ever reaches a client bundle.
export {}
