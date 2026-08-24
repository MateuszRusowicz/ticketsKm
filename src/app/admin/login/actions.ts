'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { authenticate } from '@/lib/server/login'
import { endSession, startSession } from '@/lib/server/auth'
import { rateLimit } from '@/lib/server/ratelimit'

export type LoginState = { error?: string }

const MESSAGES: Record<string, string> = {
  INVALID: 'Nieprawidłowy e-mail lub hasło.',
  LOCKED: 'Konto tymczasowo zablokowane po zbyt wielu próbach. Spróbuj za 15 minut.',
  INACTIVE: 'To konto jest nieaktywne.',
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!rateLimit(`login:${ip}`, 10, 60_000)) {
    return { error: 'Zbyt wiele prób. Odczekaj minutę.' }
  }

  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  if (!email || !password) return { error: 'Podaj e-mail i hasło.' }

  const result = await authenticate(email, password)
  if (!result.ok) return { error: MESSAGES[result.reason] }

  await startSession(result.user.id)
  redirect(result.user.role === 'ADMIN' ? '/admin' : '/admin/scan')
}

export async function logoutAction(): Promise<void> {
  await endSession()
  redirect('/admin/login')
}
