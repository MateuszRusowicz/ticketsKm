import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
// Direct argon2 call with shared parameters — the seed runs under tsx,
// where lib/server/password.ts's `import 'server-only'` would throw.
import { hash } from '@node-rs/argon2'
import { ARGON2_OPTIONS } from '../src/lib/shared/password-options'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! }),
})

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

  const concerts = [
    {
      slug: 'wieczor-bachowski',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: new Date('2026-08-14T17:00:00Z'), // 19:00 Europe/Warsaw
      pricePln: 8000,
      priceEur: 1900,
      pl: { title: 'Wieczór Bachowski', description: 'Koncert inauguracyjny festiwalu.', performers: 'J.S. Bach' },
      de: { title: 'Bach-Abend', description: 'Eröffnungskonzert des Festivals.', performers: 'J.S. Bach' },
      en: { title: 'Bach Evening', description: 'Festival opening concert.', performers: 'J.S. Bach' },
    },
    {
      slug: 'karlowicz-kwartet',
      venueId: krzyzowa.id,
      capacity: 300,
      startsAt: new Date('2026-08-16T18:00:00Z'), // 20:00 Europe/Warsaw
      pricePln: 6000,
      priceEur: 1400,
      pl: { title: 'Karłowicz i przyjaciele', description: 'Muzyka kameralna.', performers: 'Mieczysław Karłowicz' },
      de: { title: 'Karłowicz und Freunde', description: 'Kammermusik.', performers: 'Mieczysław Karłowicz' },
      en: { title: 'Karłowicz and Friends', description: 'Chamber music.', performers: 'Mieczysław Karłowicz' },
    },
    {
      slug: 'koncert-finalowy',
      venueId: swidnica.id,
      capacity: 900,
      startsAt: new Date('2026-08-22T17:00:00Z'),
      pricePln: 9000,
      priceEur: 2100,
      pl: { title: 'Koncert finałowy', description: 'Zakończenie festiwalu.', performers: 'Wszyscy artyści' },
      de: { title: 'Abschlusskonzert', description: 'Festivalabschluss.', performers: 'Alle Künstler' },
      en: { title: 'Closing Concert', description: 'End of the festival.', performers: 'All artists' },
    },
  ]

  for (const c of concerts) {
    await db.event.upsert({
      where: { slug: c.slug },
      update: {},
      create: {
        slug: c.slug,
        venueId: c.venueId,
        startsAt: c.startsAt,
        capacity: c.capacity,
        status: 'ON_SALE',
        translations: {
          create: [
            { locale: 'pl', ...c.pl },
            { locale: 'de', ...c.de },
            { locale: 'en', ...c.en },
          ],
        },
        ticketTypes: { create: [{ pricePln: c.pricePln, priceEur: c.priceEur }] },
      },
    })
  }

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

  console.log('Seeded 2 venues, 3 concerts, 2 admin accounts.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
