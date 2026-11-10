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
| `tests/replenishment.test.ts` | Lageropfyldning: prognose efter hvert stop, lager til 5 af 7 stop → forslag efter stop 4 → godkendelse → chaufføraccept → afhentning → billager opdateres først ved bekræftelse, afvisning → alternativ, observatør kan ikke godkende, ingen reaktion → påmindelse/eskalering/udløb, ny ordre ændrer behovet, chaufførens lagermelding, to chauffører om samme centrallager (ingen dobbeltreservation), genstart midt i opfyldning |
| `tests/management.test.ts` | Ledelsesgruppe: omsætning i dag (præcist tal), chaufførstatus, lager/ventende/forsinkelser/lagerproblemer/"hvorfor", uklar instruktion, omfordeling med bekræftelse og chaufføraccept, observatør afvist, ukendt bruger/forkert chat afvist, kun udsteder/admin kan bekræfte, kritiske regler kræver administrator, prioritering (med og uden løftebrud), bedre rute, godkendelse af opfyldning via tekst, revisionsspor |
| `tests/reports.test.ts` | Timerapporter: tidszone og sommer-/vintertid (23/25-timers døgn, to perioder kl. 02–03), åbningstider i lokal tid, tal fra databasen (omsætning, dækningsbidrag, leveringstid, til tiden), ingen dobbeltrapport ved gentagne kørsler/genstart, kun seneste periode efter 5 timers nedetid, nedbrud før udbakke (genoptages) og under afsendelse (usikker, gensendes ikke), uden Claude API, på forespørgsel i gruppen, manglende Telegram |
| `tests/monitor.test.ts` | Proaktiv overvågning: forsinkelse A → B → D med én besked pr. eskalering og automatisk lukning, chauffør der ikke svarer, manglende kapacitet og stigende ordretilgang, lagerunderskud med godkendelse (ingen dobbelt besked) og udløbende godkendelse, integrationsfejl og kvittering, risiko for løftebrud, beslutningslog |
| `tests/robustness.test.ts` | Genstart under aktiv ordre og under ledelsesgodkendelse (dobbelttryk, afbrudt udførelse → usikker), genstart efter 3 timers nedetid, Telegram-udfald (beskeder venter og sendes én gang), dublerede og forsinkede Telegram-opdateringer, samtidige ordreændringer (optimistisk låsning), 200 samtidige reservationer om 50 varer, udløbne knapper, manglende Claude API (regelbaseret reserve), ugyldige AI-svar, Google Maps-fejl |
| `tests/simulation.test.ts` | Hel arbejdsdag (45 ordrer, 4 chauffører, fejlvinduer): ordrer forsvinder ikke, ingen negativt eller overreserveret lager, ingen dobbelt levering, højst én aktiv opfyldning pr. chauffør, kun simulerede adaptere, 12 timerapporter; reproducerbar med samme seed; strategierne får de samme ordrer; strategivalg og ærlig sammenligning (kerne) |
| `tests/adaptive.test.ts` | Etape 4.1-regressioner: hysterese uden blafren, løftebeskyttelse pr. belastningsniveau, mindst skadelige fallback (ordren afvises ikke), lav = hurtigst / høj = mindst køretid, værdivægt højst 1,25×, lavværdiordre tildeles, belastning målt i kapacitet, påfyldning ved lagerbesøg, samme beslutning tælles én gang, adaptiv er standard, simuleringsbot genbesøger ikke og ETA-fejl er ikke systematisk |
| `tests/alternatives.test.ts` | Etape 5: fortolkning af kundesvar (ja/nej/klokkeslæt/tidligste/uklart, lokal tid), accept → noteret (aldrig "bekræftet") → tildeling før tidsrummet, andet tidspunkt (for tidligt → nyt forslag), "tidligste", afslag → medarbejder, intet svar → udløb, flere samtidige accepter, kapacitet ændret før accept, intern kø, lavværdiordre afvises ikke, kapacitet ved overførsel (samlet/varetype/flex), næsten fuld bil, påfyldning over kapacitet (DB pr. lagerenhed), lager mangler vare, ny aftalt levering ændrer påfyldning, ordre der ikke kan være i nogen bil, QA-regressioner (løfte overskrives ikke, manuel overtagelse, overvågning), demo-scenarier |
| `tests/e2e.test.ts` | Hele flowet: SMS → tilbud → bekræftelse → Telegram-accept → kører → leveret → lagerfradrag |

Seneste kørsel: **18 testfiler, 188 tests, alle bestået** (kørt gentagne gange for at udelukke ustabile tests). Alle tests kører i cloudmiljøet uden API-nøgler.

### De 14 fejlscenarier fra Etape 4

| Scenarie | Test |
|---|---|
| Genstart under en aktiv ordre | `robustness` – leveret og lager fradraget præcis én gang |
| Genstart under lageropfyldning | `replenishment` – accepteret lagerbesøg overlever genstart, afhentning registreres én gang |
| Genstart under ledelsesgodkendelse | `robustness` – bekræftelse efter genstart, dobbelttryk, afbrudt udførelse |
| Manglende Telegram-forbindelse | `robustness` (udbakke venter), `reports` (rapport markeres fejlet), `monitor` (D: overtagelse) |
| Forsinkede og dublerede Telegram-beskeder | `robustness` |
| Samtidige ordreændringer | `robustness` (optimistisk låsning), `logistics` 15 (samtidige ordrer) |
| Lagerreservation under høj belastning | `robustness` (200 om 50), `ordering` (25 samtidige kunder), `inventory` |
| Udløbne godkendelsesknapper | `robustness`, `replenishment` 12 |
| Manglende Claude API | `ai` (kundesamtaler overdrages), `robustness` + `reports` (rapport/svar uden Claude) |
| Ugyldige AI-svar | `ai` (skemavalidering), `robustness` (ledelseshandling udføres ikke) |
| Fejl i Google Maps-integration | `robustness` (geokodning), simuleringens 20-min-udfald |
| Usikker SMS-afsendelsesstatus | `takeover` (uncertain gensendes aldrig, crash under afsendelse) |
| Nedbrud under timerapport | `reports` |
| Genstart efter længere nedetid | `robustness` (udløbne tilbud), `reports` (kun seneste periode) |

## Driftssimulering

**Matrix (v0.4.1):**

```bash
npm run simulate:matrix -- --strategies fifo,shortest_detour,economic,adaptive --out docs/simulation/v0.4.1/after.json
```

Kører 100/150/300/500/1.000 henvendelser × 4 seeds/profiler × strategier
parallelt (ca. 7 min på 4 kerner). `--legacy-rules` kører med v0.4.0-reglerne.
`node scripts/sim-report.mjs` laver før/efter-rapporten. Resultater og årsagsanalyse:
`docs/simulation/v0.4.1/`.

**Etape 5 (v0.5):** `docs/simulation/v0.5/` – hybridstrategien før/efter alternative leveringstider og fysisk kapacitet (`--v041`, `--no-alternatives`), rapport med `node scripts/sim-report-v05.mjs`.

**Enkelt dag:**

```bash
npm run simulate -- --orders 300 --drivers 8 --seed 42
```

Bygger CLI'en og kører den samme arbejdsdag med de tre dispatchstrategier.
Resultatet skrives til `docs/simulation/` (Markdown + JSON). En kørsel med 300
ordrer tager ca. 1½ minut pr. strategi. Den kan også startes fra kontrolpanelet
(Drift og overvågning → Driftssimulering), hvor den kører i en worker-tråd.

**Begrænsninger:** simuleringen kører hele AI Dispatch (agenter, regler, jobkø,
database) men med simulerede kunder, chauffører, kort og Telegram, regelbaseret
fortolkning i stedet for Claude og et virtuelt ur. Den **beviser ikke** ydeevne
eller pålidelighed mod rigtige Apple Messages-, Telegram- eller Google
Maps-integrationer, rigtige køretider eller rigtige menneskers adfærd.
Kundernes adresser, efterspørgselsprofil, produktmix, vognlager og
adfærdssandsynligheder er antagelser. Der simuleres ingen medarbejder: samtaler
der overdrages (fx under kortudfald), forbliver uafklarede. Resultaterne fra v0.4.0 var
påvirket af en fejl i chauffør-botten (rettet i v0.4.1, se `docs/simulation/v0.4.1/README.md`).

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
5. **Timerapporter og overvågning:** kør en dag med rigtig ledelsesgruppe; kontrollér at rapporter kommer ved hver hele time (også omkring et skift til sommer-/vintertid), at tallene stemmer med kassen, og at advarsler ikke gentages.
6. **Ledelsesgruppe:** opret gruppe, slå privacy mode fra, knyt 3 testbrugere (én pr. rolle), test spørgsmål, afvist observatørhandling, bekræftelse og opfyldningsknapper.
7. **Electron på macOS:** `npm start`, gennemfør Demo-scenarier, test Keychain-lagring af nøgler og notifikationer.
8. **Pakning:** byg `.dmg`, installer på en ren Mac, kontroller Gatekeeper, Fuld diskadgang og Automation-tilladelser.
