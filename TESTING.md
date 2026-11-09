# Test

## Automatiske tests

```bash
npm test
```

Vitest, Node-miljø, in-memory SQLite (eller midlertidige filer ved genstartstests).
Alle eksterne integrationer erstattes af simulerede adaptere, falske processer
eller mockede HTTP-svar – **testene kalder aldrig rigtige API'er og sender aldrig
rigtige beskeder**.

| Fil | Dækker |
|---|---|
| `tests/core.test.ts` | Ordretilstandsmaskine (gyldige/ugyldige skift, aktørregler), prisberegning, telefonnumre, åbningstider over midnat |
| `tests/inventory.test.ts` | Reservation/frigivelse/fradrag (idempotent), sidste vare til kun én ordre, atomisk reservation, regulering, flytning af reservation, annullering |
| `tests/ordering.test.ts` | Dubletbeskyttelse (samme GUID, idempotente outbox-nøgler og kladder), flere hurtige SMS = ét svar, manglende adresse, ændring før bekræftelse, kundeannullering, udløbne tilbud, leveringsområde, klage → medarbejder, 25 samtidige kunder |
| `tests/takeover.test.ts` | Human Takeover (ingen AI-beskeder, blokering af ventende svar, medarbejderbeskeder, registrering af manuelle iPhone-svar, egne beskeder genkendes, ingen bagudrettede svar), usikker afsendelse gensendes aldrig, `not_started` prøves igen, crash under afsendelse |
| `tests/dispatch.test.ts` | Chaufførvalg efter billager, ingen chauffør, afvisning/timeout → næste chauffør, reservation flyttes ved accept, chaufførbeskeder (fremme, forsinket, kunden svarer ikke, mangel på vare, leveret), validering af ejerskab, tvetydige beskeder, Telegram-tilknytning |
| `tests/ai.test.ts` | Validering af AI-output, skema, prisberegning, AI kan ikke sætte priser, telefonnummer sendes ikke til AI, eskalering ved lav sikkerhed, modelfallback, vedvarende API-fejl, budgetstop, ingen nøgle, forbrugslogning |
| `tests/adapters.test.ts` | imsg JSON-RPC (falsk proces): cursor, mapping, gruppebeskeder, afsendelses-dispositioner, procesnedbrud, manglende diskadgang. Telegram: mapping, rate limit, timeout. Google: geokodning, Routes-matrix |
| `tests/restart.test.ts` | Data, cursor og jobs overlever genstart, backup + gendannelse, migrationer, CHECK-constraints, produktion starter med automatik slået fra, jobkø (dedupe, retry, permanent fejl) |
| `tests/logistics.test.ts` | De 15 logistikscenarier: 5-min-melding og "stå klar"-SMS, 10 min forsinkelse ved A → genberegning af A–D, kun relevante kunder opdateres (og ingen gentagelser ved små ændringer), ordre 3 min fra eksisterende stop, stor ordre (5.000 kr.) mod mindre, stor ordre afvist når den bryder løfter, uklar besked, chauffør svarer ikke (tilbud udløber, statusforespørgsel, eskalering), flere mulige chauffører, ruteændring kræver accept, forældet ETA, genstart midt i ruteændring, samtidige ordrer. Desuden: "færdig med X, kører mod Y", trafikforsinkelse, ekstra kapacitet og at live-position ikke gemmes. Bruger et deterministisk testkort (30 km/t). |
| `tests/e2e.test.ts` | Hele flowet: SMS → tilbud → bekræftelse → Telegram-accept → kører → leveret → lagerfradrag |

Seneste kørsel: **10 testfiler, 90 tests, alle bestået** (kørt gentagne gange for at udelukke ustabile tests). Alle tests kører i cloudmiljøet uden API-nøgler.

## Typecheck og build

```bash
npm run typecheck
```

```bash
npm run build
```

## Browsertest af UI (uden Electron)

```bash
npm run dev:web
```

Åbn http://127.0.0.1:5199. Under udviklingen er alle sider gennemklikket
automatisk med Playwright/Chromium mens Demo-simulatoren kørte scenarier – uden
JavaScript-fejl.

## Manuelle tests før produktion

1. **SMS Proof of Concept** – se INTEGRATIONS.md (12 trin, rigtig iPhone + Mac).
2. **Telegram:** opret testbot, forbind en chauffør med kode, gennemfør tilbud → accept → kører → fremme → leveret; test live-position.
3. **Google Maps:** test med 10 rigtige adresser i leveringsområdet, inkl. adresser med etage/dør og stavefejl.
4. **Claude:** evaluer fortolkning på mindst 50 anonymiserede, rigtige kundebeskeder; mål omkostning pr. ordre i AI Control Center.
5. **Electron på macOS:** `npm start`, gennemfør Demo-scenarier, test Keychain-lagring af nøgler og notifikationer.
6. **Pakning:** byg `.dmg`, installer på en ren Mac, kontroller Gatekeeper, Fuld diskadgang og Automation-tilladelser.
