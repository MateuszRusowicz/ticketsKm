import type { ReactNode } from 'react'
import { fontVariables } from '@/app/fonts'
import '@/app/globals.css'

// Admin pages are Polish only and must never be indexed.
export const metadata = { robots: { index: false, follow: false } }

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className={fontVariables}>
      <body>{children}</body>
    </html>
  )
}
