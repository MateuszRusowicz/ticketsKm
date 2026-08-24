'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'

const initial: LoginState = {}

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initial)

  return (
    <main className="mx-auto max-w-[400px] px-4 py-16">
      <h1 className="font-serif text-2xl font-bold text-[var(--color-text-primary)]">
        Panel administracyjny
      </h1>

      <form action={action} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">E-mail</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            className="min-h-[48px] rounded-[2px] border border-[var(--color-border-input)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Hasło</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="min-h-[48px] rounded-[2px] border border-[var(--color-border-input)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          />
        </label>

        {state.error && (
          <p role="alert" className="text-sm text-[var(--color-accent)]">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="min-h-[48px] rounded-[2px] bg-[var(--color-accent)] px-4 font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Logowanie…' : 'Zaloguj się'}
        </button>
      </form>
    </main>
  )
}
