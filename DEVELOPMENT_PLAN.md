# Udviklingsplan

✅ = implementeret og testet automatisk · 🟡 = implementeret, kræver test på rigtig hardware/konto · ⬜ = mangler

## Etape 1 – Teknisk validering
- ✅ Repository undersøgt (tomt) og projektbase etableret
- ✅ Teknologistak valgt og begrundet (ARCHITECTURE.md)
- ✅ Arkitektur oprettet
- ✅ Apple Messages-integration undersøgt (imsg vs. imessage-bridge, SMS/iMessage/RCS/videresendelse)
- 🟡 SMS-adapter (imsg RPC) – testet mod falsk proces; PoC på hardware mangler
- ✅ SMS-simulator
- ✅ Tekniske begrænsninger og PoC-protokol dokumenteret (INTEGRATIONS.md)

## Etape 2 – Grundsystem
- ✅ Desktopapplikation (Electron + React) – 🟡 ikke kørt i Electron på macOS i dette miljø; UI testet i Chromium
- ✅ SQLite-database, migrationer, backup før migration
- ✅ Ordresystem med tilstandsmaskine, hændelseslog, optimistisk låsning
- ✅ Produkter, priser, varianter, deaktivering
- ✅ Lager: centrallager + biler, reservation, frigivelse, fradrag, overførsel
- ✅ Dashboard og alle kontrolpanelsider
- ✅ Demo Mode med simulerede kunder og chauffører

## Etape 3 – AI
- 🟡 Claude API-integration (SDK, strukturerede outputs) – testet med falsk LLM
- ✅ Customer Agent / Order Agent (regelbaseret i demo, Claude i produktion)
- ✅ Validering af AI-handlinger mod forretningsregler
- ✅ Forbrugsovervågning, modelvalg, budget, fallback
- ⬜ Evalueringssæt med rigtige (anonymiserede) danske kundebeskeder
- ⬜ Prompt-tuning efter evaluering

## Etape 4 – Chauffører og logistik
- 🟡 Telegram-integration (long polling, knapper, tilknytning, live-position)
- ✅ Chaufførstyring
- 🟡 Google Maps (Geocoding, Routes Matrix) + caching
- ✅ Ruteoptimering: økonomisk indsættelsesmodel med hårde løftebegrænsninger, bindende ruter, ruteplaner i tilbud
- ✅ Telegram-baseret ETA (ingen live-GPS), usikkerhed, statusforespørgsler, kundeopdateringer med grænser
- ⬜ Kalibrering af økonomiske vægte og historisk tillæg på rigtige leveringsdata
- ✅ Lager i køretøjer + validering ved tildeling
- ✅ Automatisk dispatch med tilbud/accept/timeout
- ⬜ Udsendelse til fælles chaufførgruppe
- ⬜ Rigtigt kort (Google Maps JS) over planlagte stop i Logistik-siden (nu skematisk; viser aldrig live-position)

## Etape 5 – Samlet automatisering
- ✅ End-to-end ordreflow
- ✅ Forsinkelseshåndtering (chaufførmeldinger, ETA-overvågning, kundebesked)
- ✅ Human Takeover
- ✅ Fejlhåndtering (retries, usikre afsendelser, fallback, overdragelse)
- ✅ Overvågning (hændelser, integrationsstatus, notifikationer)
- ⬜ Betalingsintegration (MobilePay o.l.) – kræver forretningsbeslutning

## Etape 6 – Produktklar installation
- ✅ Opsætningsguide
- 🟡 Pakning (.dmg) – konfiguration klar; skal bygges, signeres og notariseres på Mac
- ✅ Backup og gendannelse
- ⬜ Automatiske opdateringer (electron-updater) – strategi beskrevet i INSTALLATION.md
- ✅ Dokumentation
- ✅ End-to-end-tests (simulerede adaptere)

## Næste etape (forslag)

1. **SMS Proof of Concept på rigtig iPhone + Mac** (blokerende for drift).
2. Kør appen i Electron på macOS, byg `.dmg`, test Keychain og tilladelser.
3. Telegram-test med rigtig bot og 1–2 chauffører; Google Maps-test med rigtige adresser.
4. Claude-evaluering på rigtige beskeder; justér prompts, modeller og budget.
5. electron-updater og release-pipeline.
6. Forretningsbeslutninger: betaling, aldersgrænser for visse varer, leveringsgebyrer pr. zone.
