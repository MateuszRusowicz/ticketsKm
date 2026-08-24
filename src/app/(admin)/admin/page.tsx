import Link from 'next/link'
import { requireAdmin } from '@/lib/server/auth'
import { logoutAction } from './login/actions'

export default async function AdminHome() {
  const admin = await requireAdmin()

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-16">
      <h1 className="font-serif text-3xl font-bold">Panel administracyjny</h1>
      <p className="mt-2 text-[var(--color-text-secondary)]">
        Zalogowano jako {admin.name} ({admin.email})
      </p>

      <nav className="mt-8">
        <Link href="/admin/events" className="text-accent underline">
          Koncerty
        </Link>
      </nav>

      <form action={logoutAction} className="mt-8">
        <button type="submit" className="text-sm underline">
          Wyloguj się
        </button>
      </form>
    </main>
  )
}
