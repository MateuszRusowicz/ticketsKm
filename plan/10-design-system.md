# 10 — Design system

Visual language for the ticket shop, the PDF ticket and the transactional
emails. The reference is the festival's printed matter: formal invitations,
diplomatic programmes, official concert leaflets. Generous whitespace, narrow
measure, serif headings, near-square edges, one restrained accent.

The guidelines below were set by the product owner; the original Polish text is
preserved verbatim in the appendix. Where this document adds to them, it is
marked as such and the reason is given.

---

## 1. Tokens

`src/app/globals.css`:

```css
:root {
  color-scheme: light;

  /* Colour */
  --color-background:      #FFFFFF;  /* page ground */
  --color-surface:         #F8F9FA;  /* raised sections: pricing, summaries */
  --color-text-primary:    #1A1A1A;  /* body, headings */
  --color-text-secondary:  #4A4A4A;  /* venues, dates, supporting copy */
  --color-accent:          #C4122D;  /* interaction, one accent only */
  --color-border:          #E0E0E0;  /* decorative rules and dividers */

  /* Added — see §2 */
  --color-accent-hover:    #A00F25;
  --color-border-strong:   #949494;  /* interactive control borders */
  --color-border-input:    #757575;  /* form field borders */
  --color-success:         #1E6B3A;
  --color-warning:         #8A5A00;
  --color-danger:          var(--color-accent);
  --color-focus:           var(--color-accent);

  /* Typography */
  --font-primary:   'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-secondary: 'Merriweather', Georgia, 'Times New Roman', serif;

  /* Spacing — multiples of 8px */
  --space-1: 0.5rem;   /*  8px */
  --space-2: 1rem;     /* 16px */
  --space-3: 1.5rem;   /* 24px */
  --space-4: 2rem;     /* 32px */
  --space-6: 3rem;     /* 48px */
  --space-8: 4rem;     /* 64px */
  --space-12: 6rem;    /* 96px */

  /* Form */
  --radius:       2px;
  --border-width: 1px;

  /* Layout */
  --measure-form:    800px;   /* checkout, forms */
  --measure-prose:   65ch;    /* concert descriptions */
  --measure-page:   1200px;   /* programme listing */
}
```

The palette is light-only and deliberately so — printed matter has no dark mode,
and `color-scheme: light` stops browsers from auto-inverting form controls.

---

## 2. Accessibility corrections

**Added, not in the original brief.** One rule in the guidelines conflicts with
WCAG and needs adjusting before it reaches code.

The contrast audit of the palette against `#FFFFFF`:

| Token | Ratio on white | Verdict |
|---|---|---|
| `--color-text-primary` `#1A1A1A` | **17.4 : 1** | AAA |
| `--color-text-secondary` `#4A4A4A` | **8.9 : 1** | AAA |
| `--color-accent` `#C4122D` | **6.0 : 1** | AA for all text; also passes as white-on-accent for buttons |
| `--color-border` `#E0E0E0` | **1.3 : 1** | fails WCAG 1.4.11 for UI components |

The palette is strong. The single problem is the last row: §4 of the brief asks
for form fields with `1px solid var(--color-border)`, but **WCAG 2.1 SC 1.4.11
(Non-text Contrast) requires 3:1 for the visual boundary of a user-interface
component**, and `#E0E0E0` gives 1.3:1. A field outlined in it is effectively
invisible to anyone with reduced contrast sensitivity — and an invisible field
on a checkout form costs sales, quite apart from the compliance question.

The fix keeps the intended look:

- `--color-border` `#E0E0E0` stays, used **only** for decorative rules,
  dividers, table lines and the ticket's cut lines.
- `--color-border-input` `#757575` (4.6:1) is used for **form field borders**.
- `--color-border-strong` `#949494` (3.0:1, the minimum) for secondary button
  outlines and other component boundaries where a lighter line is wanted.

Visually this reads as the same restrained hairline; it is simply dark enough to
exist. Everything else in the brief passes as written.

---

## 3. Typography

### Loading

Both faces are **self-hosted via `next/font`**, not linked from Google's CDN:

```ts
// src/app/fonts.ts
import { Merriweather } from 'next/font/google'

export const merriweather = Merriweather({
  weight: ['300', '400', '700'],
  subsets: ['latin', 'latin-ext'],   // latin-ext is required for ą ć ę ł ń ó ś ż ź
  display: 'swap',
  variable: '--font-merriweather',
})
```

`next/font` downloads the files at build time and serves them from our own
origin. Two reasons this matters here, beyond performance:

1. **`latin-ext` is mandatory.** Without it, Polish diacritics fall back to a
   different face mid-word — "Świdnicy" renders with a foreign ś. On a festival
   site this is immediately visible and looks careless.
2. **A German court (LG München I, 2022) held that embedding Google Fonts from
   Google's servers transmits the visitor's IP address without consent and
   breaches GDPR.** With a substantial German audience, self-hosting removes the
   question entirely. This is why the CDN is not used.

Helvetica Neue is a system font and loads nothing. On Windows and Android it
falls back to Arial, which is the intended behaviour — the stack is chosen for
neutrality, not for a specific face.

### Scale

Serif for names — concert titles, composers, institutions. Sans for interface,
labels, body copy, numbers.

```css
h1, h2, h3, .concert-title, .composer {
  font-family: var(--font-secondary);
  font-weight: 700;
  letter-spacing: -0.01em;
}
body, button, input, label, .meta {
  font-family: var(--font-primary);
  font-weight: 400;
}
.venue, .date, .supporting { color: var(--color-text-secondary); font-weight: 300; }
.institution, .proper-noun  { font-weight: 600; }   /* "Konsulat Generalny…" */
.price, .order-reference    { font-variant-numeric: tabular-nums; }
```

`tabular-nums` is added so prices align in a column and the order reference does
not shift width between digits.

Long-form bilingual copy uses weight 300–400; proper nouns and institutions use
600–700, per the brief.

### Fluid sizing and German compounds

```css
h1 { font-size: clamp(1.75rem, 1.2rem + 2.2vw, 3rem);   line-height: 1.15; }
h2 { font-size: clamp(1.375rem, 1.1rem + 1.2vw, 2rem);  line-height: 1.25; }
p  { font-size: clamp(1rem, 0.96rem + 0.2vw, 1.125rem); line-height: 1.65; }
```

Fluid type alone does not solve the compound-noun problem the brief raises.
`Kammermusikfestival` and `Bundesrepublik Deutschland` overflow narrow columns
because browsers will not break inside a word without being told how. The actual
fix is hyphenation, and hyphenation requires the language to be declared:

```css
h1, h2, h3, p, .concert-title {
  hyphens: auto;
  overflow-wrap: break-word;      /* last-resort break for unhyphenatable strings */
}
```

```html
<html lang="de">   <!-- set from the route locale — this is what selects the
                        hyphenation dictionary; without it `hyphens: auto`
                        does nothing -->
```

`next-intl` already gives us the active locale, so `lang` is set from it in the
root layout. The German pages are the test case; check `Kammermusikfestival` at
320px width.

---

## 4. Spacing and layout

Everything is a multiple of 8px. No arbitrary values.

```css
.section   { padding: var(--space-8) var(--space-4); }   /* 4rem 2rem */
.container { max-width: var(--measure-page); margin-inline: auto; }
.form-container, .checkout { max-width: var(--measure-form); margin-inline: auto; }
.prose     { max-width: var(--measure-prose); }
```

The narrow measure is the point of the whole brief. Bilingual programme
information is read in parallel columns on printed matter, and a wide line of
text destroys that. `800px` for forms, `65ch` for descriptions.

On mobile, section padding drops to `var(--space-4) var(--space-2)` — the
"breathing" margins are a desktop luxury; on a phone they only shrink the
measure further.

---

## 5. Components

### Buttons

```css
.btn {
  font-family: var(--font-primary);
  font-weight: 600;
  border-radius: var(--radius);          /* 2px — publishing, not consumer app */
  padding: var(--space-2) var(--space-3);
  min-height: 48px;                      /* touch target */
  transition: background-color 120ms ease;
}
.btn--primary {
  background: var(--color-accent);
  color: #FFFFFF;                        /* 6.0:1 — AA */
  border: var(--border-width) solid var(--color-accent);
}
.btn--primary:hover { background: var(--color-accent-hover); }
.btn--secondary {
  background: transparent;
  color: var(--color-text-primary);
  border: var(--border-width) solid var(--color-border-strong);
}
```

`min-height: 48px` is added: most buyers arrive from a phone, and the primary
button on this site is "pay".

### Form fields

```css
.field {
  border: var(--border-width) solid var(--color-border-input);  /* see §2 */
  border-radius: var(--radius);
  padding: var(--space-2);
  min-height: 48px;
  font-family: var(--font-primary);
  font-size: 1rem;                       /* never below 16px — iOS zooms on focus below it */
  background: var(--color-background);
}
.field:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
  border-color: var(--color-text-primary);
}
.field[aria-invalid='true'] { border-color: var(--color-accent); border-width: 2px; }
```

The focus ring is `outline`, not a border swap, so focusing a field never shifts
layout. `outline-offset: 2px` keeps it visible against the field's own line.

Errors are never signalled by colour alone — every invalid field carries an
error message referenced by `aria-describedby`, per WCAG 1.4.1.

`font-size: 1rem` on inputs is not cosmetic: iOS Safari zooms the viewport when
focusing an input below 16px, which on a checkout form reads as a bug.

### Surfaces

`--color-surface` is for the order summary, the price breakdown and the ticket
card — the sections a reader scans rather than reads. It carries a `1px solid
var(--color-border)` rule rather than a shadow. No shadows anywhere: printed
matter has no drop shadows, and adding them here breaks the register instantly.

---

## 6. Stripe Payment Element

The Payment Element renders inside an iframe and will look like a foreign object
unless it is themed. Stripe's Appearance API maps onto the tokens directly:

```ts
const appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary:    '#C4122D',
    colorBackground: '#FFFFFF',
    colorText:       '#1A1A1A',
    colorTextSecondary: '#4A4A4A',
    colorDanger:     '#C4122D',
    fontFamily:      "'Helvetica Neue', Helvetica, Arial, sans-serif",
    borderRadius:    '2px',
    spacingUnit:     '4px',
  },
  rules: {
    '.Input':        { border: '1px solid #757575', boxShadow: 'none' },
    '.Input:focus':  { outline: '2px solid #C4122D', outlineOffset: '2px', boxShadow: 'none' },
    '.Label':        { fontWeight: '600' },
  },
}
```

Note the `.Input` border uses `#757575`, the corrected value from §2 — Stripe's
fields are user-interface components and fall under the same contrast rule.

Verify the theming against **all** enabled methods, not just cards. The BLIK and
Przelewy24 panels render differently and are what most buyers will actually see.

---

## 7. Carrying the design onto the ticket and the email

The design system does not stop at the website. Two places need it restated,
because neither can read a CSS variable.

**The PDF ticket** (`pdf-lib`). Colours are hardcoded as `rgb()` values matching
the tokens. Merriweather must be **embedded** as a TTF through `@pdf-lib/fontkit`
— pdf-lib's standard fonts do not include it, and they do not cover Polish
diacritics either, so an unembedded ticket renders "Świdnica" wrong. The layout
follows the same rules: generous margins, serif concert title, grey venue line,
a hairline `#E0E0E0` border around the QR block, one accent rule at the top.

**Transactional emails.** Email clients do not support CSS variables, custom
fonts are unreliable, and `hyphens: auto` is ignored. Therefore:

- Hex values are inlined literally.
- The font stack degrades to `Georgia, serif` for headings and
  `Helvetica, Arial, sans-serif` for body — no web fonts.
- Single-column, `max-width: 600px`, tables for layout.
- The accent is used once, for the ticket link, and the link is also underlined
  — colour alone is not an affordance in email.

---

## 8. Responsive rules

- **One column below 768px.** The entire purchase form becomes
  `flex-direction: column`; no side-by-side fields, including the
  first-name/last-name pair.
- Fluid type per §3; hyphenation with a correct `lang` attribute.
- Touch targets ≥48px.
- The programme listing goes from a multi-column grid to a stacked list — not a
  horizontally scrolling carousel, which hides concerts.
- The scanner page (`/admin/scan`) is exempt from this system. It is a utility
  used one-handed in a dark foyer and needs large, saturated, full-screen colour
  states — see [05](05-admin-and-scanner.md). Elegance is the wrong goal there.

---

## 9. Where this lands in the build

| Item | Phase |
|---|---|
| Tokens in `globals.css`, Tailwind theme mapping, `next/font` setup | 0.3 |
| `lang` attribute wired to the locale, hyphenation | 0.7 |
| Button, field, surface components | 0.3 |
| Applied to the programme and concert pages | 2.1–2.2 |
| Applied to the purchase form; one-column mobile | 2.5–2.8 |
| Stripe Appearance API theming | 4.4 |
| PDF ticket styling with embedded Merriweather | 5.6 |
| Email template styling | 5.7 |
| Contrast and keyboard-navigation audit across all three languages | 8.4 |

Tailwind v4 is what `create-next-app` scaffolds, and it has no
`tailwind.config.ts` — tokens are declared in CSS and Tailwind generates the
utilities from them. So §1's block goes inside `@theme` rather than `:root`,
and there is exactly one source of truth:

```css
/* src/app/globals.css */
@import 'tailwindcss';

@theme {
  --color-background: #FFFFFF;
  --color-surface: #F8F9FA;
  --color-text-primary: #1A1A1A;
  --color-text-secondary: #4A4A4A;
  --color-accent: #C4122D;
  --color-accent-hover: #A00F25;
  --color-border: #E0E0E0;
  --color-border-strong: #949494;
  --color-border-input: #757575;

  --font-primary: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-secondary: var(--font-merriweather), Georgia, serif;

  --radius: 2px;
}
```

Declaring them there gives both forms at once: `var(--color-accent)` for
hand-written CSS and inline styles, and generated utilities — `bg-accent`,
`bg-surface`, `border-border-input`, `text-text-secondary` — for markup. The
doubled words in a few of those class names are the price of keeping the token
names exactly as specified above; renaming them to read better in markup would
break the one-source-of-truth property that makes the contrast test meaningful.

Anything not in the `--color-*`, `--font-*` or `--radius` namespaces (the
spacing scale, the measures) stays an ordinary custom property in `:root` —
Tailwind's own spacing scale already covers the 8px grid.

---

## Appendix — original guidelines (PL)

> **1. Zmienne kolorystyczne (CSS Variables)**
> Zastosuj minimalistyczną i elegancką paletę barw, odpowiednią dla oprawy
> wizualnej zaproszeń dyplomatycznych i oficjalnych druków festiwalowych.
> `--color-background: #FFFFFF` (Czysta biel dla tła, zapewniająca wysoką
> czytelność wielojęzycznych tekstów).
> `--color-surface: #F8F9FA` (Bardzo jasny szary dla sekcji wyróżnionych, np.
> cenników).
> `--color-text-primary: #1A1A1A` (Głęboki grafit dla głównych tekstów).
> `--color-text-secondary: #4A4A4A` (Szary dla informacji uzupełniających,
> takich jak miejsca koncertów, np. "Kościół Pokoju w Świdnicy").
> `--color-accent: #C4122D` (Klasyczna głęboka czerwień lub burgund, jako akcent
> dla interakcji).
> `--color-border: #E0E0E0` (Jasnoszary dla subtelnych podziałów interfejsu i
> biletów).
>
> **2. Typografia**
> Stylistyka musi korespondować z układem formalnego, klasycznego zaproszenia.
> `--font-primary: 'Helvetica Neue', Helvetica, Arial, sans-serif;` (Główny font
> interfejsu, gwarantujący czystość formy).
> `--font-secondary: 'Merriweather', 'Georgia', serif;` (Font szeryfowy dla
> tytułów koncertów, nagłówków oraz nazwisk kompozytorów, takich jak "J.S. Bach"
> czy "Mieczysław Karłowicz").
> `font-weight`: Stosuj 300 lub 400 dla długich tekstów dwujęzycznych oraz 600
> lub 700 dla wyróżnienia nazw własnych i instytucji (np. "Konsulat Generalny
> Republiki Federalnej Niemiec").
>
> **3. Odstępy i Layout (Spacing & Layout)**
> Interfejs musi sprawiać wrażenie "przestrzennego", naśladując rygorystyczny
> układ typograficzny drukowanych materiałów informacyjnych wydarzenia
> "Krzyżowa-Music Kammermusik-Festival".
> Oprzyj layout na skali wielokrotności 8px (8px, 16px, 24px, 32px itd.).
> Wprowadź duże, oddychające marginesy w głównych sekcjach (np.
> `padding: 4rem 2rem;`), aby umożliwić swobodne przetwarzanie informacji
> podawanych równolegle w języku polskim i niemieckim.
> Ogranicz maksymalną szerokość kontenera głównego z formularzem (np.
> `max-width: 800px`), utrzymując w ten sposób wąskie kolumny tekstu typowe dla
> zaproszeń.
>
> **4. Interfejs i Komponenty Płatności**
> Przyciski: Stosuj ostre lub jedynie delikatnie zaokrąglone krawędzie
> (`border-radius: 0` lub `2px`), co nadaje projektowi wydawniczy, poważny
> charakter.
> Formularze: Zbuduj minimalistyczne pola tekstowe z pojedynczym obramowaniem
> (np. `1px solid var(--color-border)`). Zadbaj o wyraźne wskazanie stanu focus
> dla wsparcia dostępności (WCAG).
>
> **5. Responsywność (RWD)**
> Zastosuj mechanizm płynnego skalowania typografii (fluid typography) na
> urządzeniach mobilnych, aby zapobiec łamaniu się długich słów,
> charakterystycznych dla złożonego nazewnictwa w języku niemieckim (np.
> "Bundesrepublik Deutschland").
> Wymuś strukturę jednokolumnową (`flex-direction: column`) dla całego
> formularza zakupu na ekranach mobilnych.
