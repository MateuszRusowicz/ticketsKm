import type { ReactNode } from 'react'

/**
 * Shared shell for the terms and privacy pages.
 *
 * Both exist before their text does: Stripe onboarding asks for these URLs,
 * and selling to consumers in Poland without a published `regulamin` is a
 * legal problem. The draft banner is deliberately hard to miss so a
 * placeholder cannot quietly go live.
 */
export function LegalPage({
  title,
  intro,
  draftNotice,
  sections,
}: {
  title: string
  intro: string
  draftNotice: string
  sections: { heading: string; body: ReactNode }[]
}) {
  return (
    <main className="mx-auto max-w-[65ch] px-8 py-12">
      <h1 className="text-3xl">{title}</h1>
      <p className="mt-2 text-text-secondary">{intro}</p>

      <p
        role="note"
        className="mt-6 border-l-4 border-accent bg-surface px-4 py-3 text-sm font-semibold"
      >
        {draftNotice}
      </p>

      {sections.map((section, i) => (
        <section key={section.heading} className="mt-8">
          <h2 className="text-xl">
            {i + 1}. {section.heading}
          </h2>
          <p className="mt-2 hyphens-auto">{section.body}</p>
        </section>
      ))}
    </main>
  )
}
