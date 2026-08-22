Architektura Systemu (Top-Level Overview)

1. Podział warstw i domeny

   Domena Główna (Wix): Służy wyłącznie do celów informacyjnych i marketingowych. Przycisk zakupowy kieruje klienta na subdomenę.

   Subdomena (np. bilety.krzyzowa-music.eu): Hostuje niestandardową aplikację sprzedażową w izolowanym, bezpiecznym środowisku.

2. Proponowany stos technologiczny

   Aplikacja (Front + Back): Next.js. Pozwala połączyć React na frontendzie z logiką backendową (API Routes lub Server Actions) w jednym projekcie.

   Baza danych: PostgreSQL połączony przez ORM (np. Prisma).

   Płatności: Stripe (Payment Element + Webhooks).

   Wysyłka e-maili: Resend lub SendGrid do wysyłki biletów transakcyjnych.

   Infrastruktura: Konteneryzacja (Docker) i wdrożenie na serwerze VPS (np. Hetzner) lub platformie serverless (np. Vercel).

3. Struktura Bazy Danych (Kluczowe Encje)

   User: Podstawowe dane kupującego.

   Event: Wydarzenia koncertowe i dostępne pule biletów.

   Transaction: Status płatności powiązany z identyfikatorem Stripe (payment_intent_id).

   Ticket: Wygenerowane wejściówki powiązane z wydarzeniem, klientem i udaną transakcją (zawierające unikalny UUID / kod QR).

Przepływ Danych (Data Flow)

    Inicjalizacja: Użytkownik przegląda program na stronie Wix, klika "Kup Bilet" i przechodzi do aplikacji w React.

    Rejestracja Koszyka: Użytkownik wybiera liczbę biletów i podaje e-mail. Frontend wysyła te dane do własnego backendu.

    Integracja Stripe: Backend kalkuluje całkowitą kwotę (całkowicie ignorując ceny przesłane z frontendu dla bezpieczeństwa) i tworzy PaymentIntent w API Stripe.

    Autoryzacja Płatności: Backend zwraca wygenerowany client_secret do aplikacji klienckiej. React bezpiecznie renderuje formularz płatności Stripe, dostosowując opcje (Przelewy24, BLIK, Giropay) do lokalizacji.

    Finalizacja transakcji: Użytkownik potwierdza płatność, a Stripe procesuje ją niezależnie od Twojej aplikacji.

    Odbiór zdarzenia (Webhook): Stripe wysyła powiadomienie payment_intent.succeeded na zabezpieczony endpoint backendowy.

    Realizacja Zamówienia: Backend potwierdza poprawność webhooka, aktualizuje status transakcji w bazie z "oczekującej" na "opłaconą", generuje bilet PDF z kodem QR i wysyła e-mail do klienta.

Harmonogram Wdrożenia (Execution Plan)

Faza 1: Środowisko i Baza Danych

    Konfiguracja repozytorium, środowiska deweloperskiego i Dockerfile.

    Utworzenie schematu bazy danych i migracji (ORM).

    Otwarcie konta Stripe w trybie testowym.

Faza 2: Logika Wyboru i Cennik

    Implementacja widoków wyboru koncertów i biletów we frontendzie.

    Zbudowanie logiki koszyka zakupowego.

    Przygotowanie mechanizmu adaptacji walut (EUR/PLN).

Faza 3: Integracja Płatności i Checkout

    Stworzenie endpointu backendowego inicjującego płatność (tworzenie PaymentIntent).

    Wdrożenie biblioteki Stripe Elements po stronie frontendu.

Faza 4: Webhooki i Logika Pozakupowa

    Konfiguracja endpointu nasłuchującego na webhooki Stripe.

    Implementacja walidacji kryptograficznej powiadomień.

    Zaprogramowanie generatora biletów (kody QR) i mechanizmu wysyłki e-maili z załącznikami.

Faza 5: Testowanie, Audyt i Wdrożenie (Deploy)

    Przejście pełnych ścieżek zakupowych w środowisku testowym Stripe z użyciem kart testowych, Przelewy24 oraz Giropay.

    Wdrożenie aplikacji (frontend + backend + baza danych) na serwer produkcyjny.

    Podpięcie kluczy produkcyjnych Stripe, konfiguracja certyfikatów SSL dla subdomeny i aktywacja linków na stronie głównej Wix.
