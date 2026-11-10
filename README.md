# AI Dispatch

AI-drevet ordre- og logistiksystem til macOS for virksomheder, der modtager
SMS-bestillinger fra privatkunder og leverer drikkevarer, snacks og lignende.

Kunderne skriver SMS til virksomhedens **eksisterende iPhone-nummer**. AI Dispatch
læser og besvarer beskederne via **Apple Messages på en Mac**, opretter og
bekræfter ordrer, reserverer lager, vælger chauffør, kommunikerer med chaufførerne
via **Telegram** og holder kunden opdateret – mens medarbejdere altid kan overtage.

> **Status (v0.5.0):** Fungerende desktop-applikation med komplet Demo Mode,
> ordresystem, lager, AI-orkestrering, økonomisk dispatch, Telegram-baserede ETA'er
> (ingen live-GPS), Human Takeover, ledelsesgruppe, proaktiv lageropfyldning,
> timerapporter, proaktiv overvågning, hel-dags-driftssimulering, adaptiv dispatchstrategi, alternative leveringstider, fysisk lagerkapacitet i bilerne og 188 automatiske tests. Rigtige integrationer (imsg/SMS,
> Telegram, Google Maps, Claude) er implementeret, men **ikke verificeret mod
> rigtig hardware/rigtige konti endnu**. Se [Status](#status).

## Hurtig start (udvikling)

Kræver Node.js 22+.

```bash
npm install
```

```bash
npm test
```

```bash
npm start
```

`npm start` bygger og åbner Electron-appen i **Demo Mode** (fiktive kunder,
chauffører og produkter – intet sendes til rigtige personer).

Uden Electron (fx på Linux/CI) kan backend + UI køres i en almindelig browser:

```bash
npm run dev:web
```

og åbn http://127.0.0.1:5199.

Kør en simuleret arbejdsdag (300 ordrer, 8 chauffører, tre dispatchstrategier):

```bash
npm run simulate -- --orders 300 --drivers 8 --seed 42
```

Hele matrixen (100–1.000 ordrer, 4 seeds, fire strategier):

```bash
npm run simulate:matrix
```

## Funktioner

| Område | Indhold |
|---|---|
| Dashboard | Aktive ordrer, ordrer/leveringer i dag, afventende, forsinkelser, chauffører, systemstatus, AI-forbrug |
| Ordrer | Live-liste, detaljer, statushistorik, manuel redigering (varer, status, annullering), tildeling af chauffør |
| Kundesamtaler | Samtaler, AI-tilstand (AI aktiv / Manuel overtagelse / AI pauseret / Integrationsfejl), Human Takeover, beskedhistorik med leveringsstatus |
| Chauffører | Status, Telegram-forbindelse via engangskode, aktive leveringer, rute, lager i bilen, beskeder |
| Logistik | Planlagte ruter, seneste Telegram-status, ETA-interval og -sikkerhed, forsinkelser, omsætning pr. chauffør og rute, leveringer pr. time, tilbud og omfordelingsforslag med økonomisk begrundelse (ingen live-GPS) |
| Produkter og lager | Katalog og priser (inkl. plads i lagerenheder), bilernes kapacitet, varetyper og faste sortiment, centrallager + billagre, regulering, overførsel, lagerbevægelser, **billager efter hvert planlagt stop, underskud og opfyldninger** |
| Ledelsescenter | Godkendelser (opfyldning), kommandolog med beslutning og resultat, gruppechat, ledere og roller (Administrator/Leder/Observatør) |
| AI Control Center | Modelvalg pr. opgave, modelpriser, budget, tokenforbrug, AI-kald, agenthændelser, automatiseringsindstillinger |
| Hændelser | Monitoring: fejl og situationer, der kræver menneskelig handling |
| Indstillinger | Virksomhed, integrationer, levering, priser, åbningstider, standardbeskeder, PIN, backup, GDPR, auditlog, tilstand |
| Opsætningsguide | 11 trin til ny installation hos en ny virksomhed |
| Drift og overvågning | Timerapporter og historik, proaktive advarsler (A/B/C/D) med beslutningslog, kritiske hændelser, integrationsstatus, driftssimulering og sammenligning af dispatchstrategier (tydeligt markeret som simuleret) |
| Demo-konsol | Scenarier, automatisk trafik, skriv som kunde/medarbejder-iPhone/chauffør/leder, opfyldningsscenarie |

## Dokumentation

- [ARCHITECTURE.md](ARCHITECTURE.md) – teknologivalg, moduler, dataflow, pålidelighed
- [INTEGRATIONS.md](INTEGRATIONS.md) – Apple Messages/SMS-research, Telegram, Google Maps, Claude, **hardwaretest (PoC)**
- [SECURITY.md](SECURITY.md) – nøgler, adgangskontrol, GDPR
- [TESTING.md](TESTING.md) – testsuite og manuelle tests
- [INSTALLATION.md](INSTALLATION.md) – installation hos en virksomhed, signering, notarisering, opdateringer
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) – etaper og status
- [CHANGELOG.md](CHANGELOG.md)
- [docs/simulation/v0.5/](docs/simulation/v0.5/) – manuelle sager, alternative leveringstider, fysisk kapacitet, QA (simulerede data)
- [docs/simulation/v0.4.1/](docs/simulation/v0.4.1/) – årsagsanalyse, adaptiv strategi og simuleringsmatrix (simulerede data)

## Status

| Del | Implementeret | Testet | Produktionsklar |
|---|---|---|---|
| Ordresystem, tilstandsmaskine, priser | ✅ | ✅ automatiske tests | ✅ (forretningsregler bør gennemgås af virksomheden) |
| Lager (central + biler, reservation) | ✅ | ✅ | ✅ |
| Telegram-baseret ETA, kundeopdateringer, økonomisk ruteplanlægning | ✅ | ✅ 15 scenarier | 🟡 vægte og grænser bør kalibreres på rigtige data |
| Ledelsesagent i Telegram (spørgsmål, handlinger, roller, bekræftelse, revisionsspor) | ✅ | ✅ 14 tests | 🟡 kræver test med rigtig gruppe + Claude-evaluering af danske ledelsesbeskeder |
| Proaktiv lageropfyldning | ✅ | ✅ 9 tests | 🟡 kræver korrekt startlager i bilerne og kalibrering af afhentningstid |
| Timerapporter og proaktiv overvågning | ✅ | ✅ 16 tests | 🟡 grænseværdier bør justeres efter første driftsuger |
| Hel-dags-driftssimulering og strategisammenligning | ✅ | ✅ reproducerbar, 4 seeds × 5 belastninger | – (simulerede data; beviser ikke rigtige integrationer) |
| Alternative leveringstider via SMS | ✅ | ✅ 29 tests + simulering | 🟡 gav kun gevinst ved midlertidig spidsbelastning i simuleringen; kræver vagtplan og rigtige kundereaktioner |
| Fysisk lagerkapacitet og kapacitetsbegrænset opfyldning | ✅ | ✅ tests + simulering | 🟡 kapaciteter, varernes plads og sortiment skal måles på rigtige biler |
| Adaptiv dispatchstrategi (standard) | ✅ | ✅ regressionstests + matrix | 🟡 grænser og vægte bør kalibreres på rigtige data |
| Demo Mode (alle integrationer simuleret) | ✅ | ✅ tests + browsertest | – (demo) |
| Human Takeover | ✅ | ✅ (simuleret) | ⚠️ automatisk registrering af manuelle iPhone-svar kræver hardwaretest |
| SMS via Apple Messages (imsg) | ✅ | ✅ mod falsk imsg-proces | ❌ kræver PoC på rigtig iPhone + Mac |
| Telegram Bot API | ✅ | ✅ mocket HTTP | ❌ kræver test med rigtig bot |
| Google Maps (Geocoding + Routes) | ✅ | ✅ mocket HTTP | ❌ kræver test med rigtig nøgle |
| Claude API (strukturerede outputs) | ✅ | ✅ falsk LLM | ❌ kræver test med rigtig nøgle + prompt-evaluering |
| Electron-app / .dmg | ✅ konfiguration | ⚠️ ikke kørt på macOS i dette miljø | ❌ kræver signering/notarisering på Mac |

## Licens

Proprietær (UNLICENSED). Tredjepartskomponenter: se `package.json` og INTEGRATIONS.md (imsg: MIT).
