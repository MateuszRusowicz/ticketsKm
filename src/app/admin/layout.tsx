import type { ReactNode } from 'react'

// Admin pages are Polish only and must never be indexed.
export const metadata = { robots: { index: false, follow: false } }

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div lang="pl">{children}</div>
}
