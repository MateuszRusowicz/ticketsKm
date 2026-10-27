import type { ReactNode } from 'react'
import { fontVariables } from '@/app/fonts'
import '@/app/globals.css'

/**
 * Root layout for the /t/<code> ticket-view paths.
 *
 * This subtree is excluded from the locale rewriting in proxy.ts so the URL
 * stays stable forever — a QR printed today must scan tomorrow regardless of
 * future routing changes. There is no locale prefix, and the page language
 * follows the order's locale rather than the URL.
 */
export default function TicketLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pl" className={fontVariables}>
      <body className="flex min-h-dvh flex-col bg-background text-text-primary">{children}</body>
    </html>
  )
}
