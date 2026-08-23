/**
 * argon2id parameters, per OWASP's recommendation for interactive logins.
 *
 * Lives in `shared/` rather than `server/` for one reason: CLI scripts run
 * under tsx, outside Next's module graph, where `import 'server-only'`
 * throws. They still must hash with exactly these parameters — an admin
 * created by a script and one created by the app have to be
 * indistinguishable — so the numbers live somewhere both can reach.
 *
 * These are parameters, not secrets. Nothing here is sensitive if bundled.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const
