/**
 * Not-found page for `/t/<code>` — rendered when:
 * - the code is malformed (invalid Crockford alphabet or wrong length)
 * - the code is valid format but does not exist in the DB
 * - rate limit exceeded (deliberately looks identical to "not found")
 *
 * The `/t` path has no locale prefix, so this page shows all three languages
 * to be useful regardless of the visitor's language.
 */
export default function TicketNotFound() {
  return (
    <main className="mx-auto max-w-[600px] px-4 pt-16 pb-16 text-center sm:px-8">
      <h1 className="text-2xl font-bold">
        Nie znaleziono biletu
        <span className="mx-3 text-text-secondary">·</span>
        Ticket not found
        <span className="mx-3 text-text-secondary">·</span>
        Eintrittskarte nicht gefunden
      </h1>

      <p className="prose-serif mt-6 text-text-secondary">
        Sprawdź adres z biletu lub skontaktuj się z organizatorem.
      </p>
      <p className="prose-serif mt-1 text-text-secondary">
        Check the address from your ticket or contact the organiser.
      </p>
      <p className="prose-serif mt-1 text-text-secondary">
        Prüfen Sie die Adresse auf Ihrer Karte oder wenden Sie sich an den Veranstalter.
      </p>

      <p className="mt-8">
        <a href="https://krzyzowa-music.eu" className="btn btn-secondary">
          krzyzowa-music.eu
        </a>
      </p>
    </main>
  )
}
