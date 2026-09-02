import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
// Direct argon2 call with shared parameters — the seed runs under tsx,
// where lib/server/password.ts's `import 'server-only'` would throw.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! }),
})

const SEED_ORDER_REFERENCE = 'KM-0000-000001'
// Must equal the seeded OrderItem.quantity: Task 9 asserts `released === 5`,
// which only holds if heldCount and the item quantity agree.
const HELD_SEED_QUANTITY = 5

async function main() {
  const swidnica = await db.venue.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Kościół Pokoju',
      address: 'Plac Pokoju 6',
      city: 'Świdnica',
      defaultCapacity: 900,
    },
  })

  const krzyzowa = await db.venue.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Pałac w Krzyżowej',
      address: 'Krzyżowa 7',
      city: 'Krzyżowa',
      defaultCapacity: 300,
    },
  })

  // Dates are relative to seed time, not hardcoded. The festival runs each
  // August, so any literal year goes stale within twelve months and the
  // programme silently empties out once every concert is in the past.
  const day = 86_400_000
  /**
   * N days from now, pinned to 17:00 UTC — 19:00 in Warsaw for most of the
   * year. Without the fixed hour every seeded concert starts at whatever time
   * the seed happened to run, which looks obviously wrong on the programme.
   */
  const inDays = (n: number) => {
    const d = new Date(Date.now() + n * day)
    d.setUTCHours(17, 0, 0, 0)
    return d
  }

  type Copy = { title: string; description: string; performers: string }
  type Concert = {
    slug: string
    venueId: string
    capacity: number
    startsAt: Date
    pricePln: number
    priceEur: number
    status: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'CLOSED' | 'CANCELLED'
    salesOpenAt?: Date
    salesCloseAt?: Date
    soldCount?: number
    pl: Copy
    de: Copy
    en: Copy
  }

  /** Fixture copy for the state-exercising concerts, which need no real text. */
  const copy = (pl: string, de: string, en: string, note: string): Pick<Concert, 'pl' | 'de' | 'en'> => ({
    pl: { title: pl, description: `Koncert testowy — ${note}.`, performers: 'Zespół festiwalowy' },
    de: { title: de, description: `Testkonzert — ${note}.`, performers: 'Festivalensemble' },
    en: { title: en, description: `Test concert — ${note}.`, performers: 'Festival ensemble' },
  })

  const concerts: Concert[] = [
    // --- the three real concerts -------------------------------------------
    {
      slug: 'wieczor-bachowski',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: inDays(60),
      pricePln: 8000,
      priceEur: 1900,
      status: 'ON_SALE',
      pl: { title: 'Wieczór Bachowski', description: 'Koncert inauguracyjny festiwalu.', performers: 'J.S. Bach' },
      de: { title: 'Bach-Abend', description: 'Eröffnungskonzert des Festivals.', performers: 'J.S. Bach' },
      en: { title: 'Bach Evening', description: 'Festival opening concert.', performers: 'J.S. Bach' },
    },
    {
      slug: 'karlowicz-kwartet',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(62),
      pricePln: 6000,
      priceEur: 1400,
      status: 'ON_SALE',
      pl: { title: 'Karłowicz i przyjaciele', description: 'Muzyka kameralna.', performers: 'Mieczysław Karłowicz' },
      de: { title: 'Karłowicz und Freunde', description: 'Kammermusik.', performers: 'Mieczysław Karłowicz' },
      en: { title: 'Karłowicz and Friends', description: 'Chamber music.', performers: 'Mieczysław Karłowicz' },
    },
    {
      slug: 'koncert-finalowy',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: inDays(68),
      pricePln: 9000,
      priceEur: 2100,
      status: 'ON_SALE',
      pl: { title: 'Koncert finałowy', description: 'Zakończenie festiwalu.', performers: 'Wszyscy artyści' },
      de: { title: 'Abschlusskonzert', description: 'Festivalabschluss.', performers: 'Alle Künstler' },
      en: { title: 'Closing Concert', description: 'End of the festival.', performers: 'All artists' },
    },

    // --- one concert per state Plan 03 has to verify ------------------------
    // Listed, but the buy box must say "sales open on <date>".
    {
      slug: 'test-przedsprzedaz',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(90),
      pricePln: 5000,
      priceEur: 1200,
      status: 'ON_SALE',
      salesOpenAt: inDays(30),
      ...copy('Sprzedaż jeszcze nieotwarta', 'Verkauf noch nicht geöffnet', 'Sales not yet open', 'sprzedaż otwiera się później'),
    },
    // Listed, not purchasable: the sales window has closed but the concert happens.
    {
      slug: 'test-sprzedaz-zamknieta',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(50),
      pricePln: 5000,
      priceEur: 1200,
      status: 'ON_SALE',
      salesCloseAt: inDays(-1),
      ...copy('Sprzedaż zakończona', 'Verkauf beendet', 'Sales closed', 'okno sprzedaży minęło'),
    },
    // soldCount === capacity, so available is 0 and the band is "sold out".
    {
      slug: 'test-wyprzedany',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(55),
      pricePln: 5000,
      priceEur: 1200,
      status: 'SOLD_OUT',
      soldCount: 300,
      ...copy('Bilety wyprzedane', 'Ausverkauft', 'Sold out', 'wyprzedany'),
    },
    // Must 404 by direct slug — an embargoed programme change must not leak.
    {
      slug: 'test-roboczy',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(70),
      pricePln: 5000,
      priceEur: 1200,
      status: 'DRAFT',
      ...copy('Szkic — niewidoczny', 'Entwurf — unsichtbar', 'Draft — not visible', 'szkic, nie powinien być widoczny'),
    },
    // Must 404 by direct slug and never be listed.
    {
      slug: 'test-odwolany',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(72),
      pricePln: 5000,
      priceEur: 1200,
      status: 'CANCELLED',
      ...copy('Koncert odwołany', 'Konzert abgesagt', 'Concert cancelled', 'odwołany'),
    },
    // CLOSED: listed, not purchasable. The concert still takes place.
    {
      slug: 'test-zamkniety',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(45),
      pricePln: 5000,
      priceEur: 1200,
      status: 'CLOSED',
      ...copy('Sprzedaż zamknięta', 'Verkauf geschlossen', 'Sales closed', 'status CLOSED'),
    },
    // In the past: must drop off the listing even though it is still ON_SALE.
    {
      slug: 'test-miniony',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: inDays(-30),
      pricePln: 5000,
      priceEur: 1200,
      status: 'ON_SALE',
      ...copy('Koncert miniony', 'Vergangenes Konzert', 'Past concert', 'termin już minął'),
    },
    {
      // Plan 04: carries a stale PENDING hold so `pnpm holds:sweep` has
      // something to sweep on a freshly seeded database, and so
      // updateEvent's "refuse a price change while held" branch can be
      // smoke-tested by hand. The matching Order is created below the loop.
      slug: 'test-w-rezerwacji',
      venueId: krzyzowa.id,
      capacity: 100,
      startsAt: inDays(80),
      pricePln: 5000,
      priceEur: 1200,
      status: 'ON_SALE',
      ...copy('Koncert z rezerwacją', 'Konzert mit Reservierung', 'Concert with a hold', 'wygasła rezerwacja'),
    },
  ]

  for (const c of concerts) {
    await db.event.upsert({
      where: { slug: c.slug },
      // Scheduling fields refresh on re-seed so relative dates stay relative.
      // Translations and ticket types are deliberately left alone — updating
      // nested creates would duplicate them.
      update: {
        startsAt: c.startsAt,
        status: c.status,
        salesOpenAt: c.salesOpenAt ?? null,
        salesCloseAt: c.salesCloseAt ?? null,
      },
      create: {
        slug: c.slug,
        venueId: c.venueId,
        startsAt: c.startsAt,
        capacity: c.capacity,
        status: c.status,
        salesOpenAt: c.salesOpenAt ?? null,
        salesCloseAt: c.salesCloseAt ?? null,
        translations: {
          create: [
            { locale: 'pl', ...c.pl },
            { locale: 'de', ...c.de },
            { locale: 'en', ...c.en },
          ],
        },
        ticketTypes: {
          create: [{ pricePln: c.pricePln, priceEur: c.priceEur, soldCount: c.soldCount ?? 0 }],
        },
      },
    })
  }

  // --- Plan 04: a stale PENDING hold on `test-w-rezerwacji` -----------------
  //
  // heldCount is set by an explicit updateMany rather than on the nested
  // ticketTypes.create above: the event upsert's `update` branch deliberately
  // leaves nested creates alone, so a value set only in `create` would revert
  // to 0 on the second seed and Task 9's `released: 5` assertion would drift
  // between runs.
  const heldEvent = await db.event.findUniqueOrThrow({
    where: { slug: 'test-w-rezerwacji' },
    select: { id: true, ticketTypes: { select: { id: true } } },
  })
  const heldTicketType = heldEvent.ticketTypes[0]

  await db.ticketType.updateMany({
    where: { eventId: heldEvent.id },
    data: { heldCount: HELD_SEED_QUANTITY },
  })

  await db.order.upsert({
    where: { reference: SEED_ORDER_REFERENCE },
    // Nothing to refresh: re-seeding must not resurrect an order the sweep has
    // already expired, or it would look like the sweep failed.
    update: {},
    create: {
      reference: SEED_ORDER_REFERENCE,
      // Deterministic so a manual smoke of the guarded order URL is
      // reproducible. A real v4 UUID, because Zod 4's z.uuid() checks the
      // version and variant bits rather than just the shape.
      accessToken: '5eed0000-0000-4000-8000-000000000001',
      kind: 'PURCHASE',
      email: 'rezerwacja@example.test',
      firstName: 'Rezerwacja',
      lastName: 'Testowa',
      locale: 'pl',
      currency: 'PLN',
      subtotal: 25000,
      discount: 0,
      total: 25000,
      status: 'PENDING',
      needsInvoice: false,
      // Already expired, so the sweep has work to do on a fresh database.
      holdExpiresAt: inDays(-1),
      attendeeNames: Array.from({ length: HELD_SEED_QUANTITY }, (_, index) => ({
        index,
        name: `Gość ${index + 1}`,
      })),
      items: {
        create: [
          {
            ticketTypeId: heldTicketType.id,
            quantity: HELD_SEED_QUANTITY,
            unitPrice: 5000,
            currency: 'PLN',
          },
        ],
      },
    },
  })

  const password = await hash('DevPassword123!', ARGON2_OPTIONS)

  await db.adminUser.upsert({
    where: { email: 'admin@krzyzowa-music.eu' },
    update: {},
    create: { email: 'admin@krzyzowa-music.eu', passwordHash: password, name: 'Administrator', role: 'ADMIN' },
  })

  await db.adminUser.upsert({
    where: { email: 'skaner@krzyzowa-music.eu' },
    update: {},
    create: { email: 'skaner@krzyzowa-music.eu', passwordHash: password, name: 'Obsługa wejścia', role: 'SCANNER' },
  })

  const orderCount = await db.order.count()
  console.log(
    `Seeded 2 venues, ${concerts.length} concerts, ${orderCount} orders, 2 admin accounts.`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
