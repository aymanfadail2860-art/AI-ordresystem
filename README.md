# AI Dispatch

AI-drevet ordre- og logistiksystem til macOS for virksomheder, der modtager
SMS-bestillinger fra privatkunder og leverer drikkevarer, snacks og lignende.

Kunderne skriver SMS til virksomhedens **eksisterende iPhone-nummer**. AI Dispatch
læser og besvarer beskederne via **Apple Messages på en Mac**, opretter og
bekræfter ordrer, reserverer lager, vælger chauffør, kommunikerer med chaufførerne
via **Telegram** og holder kunden opdateret – mens medarbejdere altid kan overtage.

> **Status (Etape 1–2 + store dele af 3–5):** Fungerende desktop-applikation med
> komplet Demo Mode, ordresystem, lager, AI-orkestrering, dispatch, ruter,
> Human Takeover og 75 automatiske tests. Rigtige integrationer (imsg/SMS,
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

## Funktioner

| Område | Indhold |
|---|---|
| Dashboard | Aktive ordrer, ordrer/leveringer i dag, afventende, forsinkelser, chauffører, systemstatus, AI-forbrug |
| Ordrer | Live-liste, detaljer, statushistorik, manuel redigering (varer, status, annullering), tildeling af chauffør |
| Kundesamtaler | Samtaler, AI-tilstand (AI aktiv / Manuel overtagelse / AI pauseret / Integrationsfejl), Human Takeover, beskedhistorik med leveringsstatus |
| Chauffører | Status, Telegram-forbindelse via engangskode, aktive leveringer, rute, lager i bilen, beskeder |
| Logistik | Skematisk kort, ruter og ETA'er, forsinkelser, åbne tilbud, omfordelingsforslag |
| Produkter og lager | Katalog og priser, centrallager + billagre, regulering, overførsel, lagerbevægelser |
| AI Control Center | Modelvalg pr. opgave, modelpriser, budget, tokenforbrug, AI-kald, agenthændelser, automatiseringsindstillinger |
| Hændelser | Monitoring: fejl og situationer, der kræver menneskelig handling |
| Indstillinger | Virksomhed, integrationer, levering, priser, åbningstider, standardbeskeder, PIN, backup, GDPR, auditlog, tilstand |
| Opsætningsguide | 11 trin til ny installation hos en ny virksomhed |
| Demo-konsol | Scenarier, automatisk trafik, skriv som kunde/medarbejder-iPhone/chauffør |

## Dokumentation

- [ARCHITECTURE.md](ARCHITECTURE.md) – teknologivalg, moduler, dataflow, pålidelighed
- [INTEGRATIONS.md](INTEGRATIONS.md) – Apple Messages/SMS-research, Telegram, Google Maps, Claude, **hardwaretest (PoC)**
- [SECURITY.md](SECURITY.md) – nøgler, adgangskontrol, GDPR
- [TESTING.md](TESTING.md) – testsuite og manuelle tests
- [INSTALLATION.md](INSTALLATION.md) – installation hos en virksomhed, signering, notarisering, opdateringer
- [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) – etaper og status
- [CHANGELOG.md](CHANGELOG.md)

## Status

| Del | Implementeret | Testet | Produktionsklar |
|---|---|---|---|
| Ordresystem, tilstandsmaskine, priser | ✅ | ✅ automatiske tests | ✅ (forretningsregler bør gennemgås af virksomheden) |
| Lager (central + biler, reservation) | ✅ | ✅ | ✅ |
| Demo Mode (alle integrationer simuleret) | ✅ | ✅ tests + browsertest | – (demo) |
| Human Takeover | ✅ | ✅ (simuleret) | ⚠️ automatisk registrering af manuelle iPhone-svar kræver hardwaretest |
| SMS via Apple Messages (imsg) | ✅ | ✅ mod falsk imsg-proces | ❌ kræver PoC på rigtig iPhone + Mac |
| Telegram Bot API | ✅ | ✅ mocket HTTP | ❌ kræver test med rigtig bot |
| Google Maps (Geocoding + Routes) | ✅ | ✅ mocket HTTP | ❌ kræver test med rigtig nøgle |
| Claude API (strukturerede outputs) | ✅ | ✅ falsk LLM | ❌ kræver test med rigtig nøgle + prompt-evaluering |
| Electron-app / .dmg | ✅ konfiguration | ⚠️ ikke kørt på macOS i dette miljø | ❌ kræver signering/notarisering på Mac |

## Licens

Proprietær (UNLICENSED). Tredjepartskomponenter: se `package.json` og INTEGRATIONS.md (imsg: MIT).
