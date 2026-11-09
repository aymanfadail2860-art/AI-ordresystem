# Arkitektur

## Teknologivalg

**Electron + TypeScript + React + SQLite (better-sqlite3)** er valgt efter vurdering:

| Krav | Vurdering |
|---|---|
| Lokal macOS-desktopapp uden Xcode som udviklingsmiljø | Electron bygges med Node-værktøjer. Xcode er ikke påkrævet; kun Xcode Command Line Tools til signering/notarisering (`codesign`, `notarytool`). |
| SQLite lokalt, transaktionssikkert | better-sqlite3 er synkron og hurtig; transaktioner kan ikke afbrydes af asynkrone hændelser midt i en lagerreservation. Forudbyggede binærer findes for Electron. |
| Adgang til OS (Keychain, child processes til imsg, notifikationer) | Electron main-proces = fuld Node. `safeStorage` bruger macOS Keychain. |
| Installerbar `.dmg`, signering, notarisering, opdateringer | electron-builder dækker det hele. |
| Alternativ: Swift/SwiftUI | Bedre native integration, men kræver Xcode og er længere fra Claude Code-workflowet. Fravalgt. |
| Alternativ: Tauri | Mindre app, men Rust-backend og færre etablerede SQLite/Keychain-mønstre. Fravalgt for vedligeholdelighed. |

Afhængigheder i drift: `better-sqlite3`, `react`, `react-dom`, `@anthropic-ai/sdk`, `zod`. Intet andet.
Ingen Supabase, Sentry, Vercel, Twilio, n8n eller SaaS-backend.

## Overblik

```
┌──────────────── Electron main-proces (Node) ────────────────┐
│  AppHost ── vælger database pr. tilstand (demo/produktion)  │
│     │                                                       │
│     ▼                                                       │
│  App (createApp)                                            │
│   ├─ SQLite + migrationer + vedvarende jobkø                │
│   ├─ Services: katalog, lager, samtaler, ordrer,            │
│   │            chauffører, kort (cache)                     │
│   ├─ Gateways:  SmsGateway ──► SmsAdapter (imsg | simulator)│
│   │             TelegramGateway ──► (Bot API | simulator)   │
│   ├─ AI: AiGateway (budget, modelvalg, logning)             │
│   │      ├─ Claude-fortolkere (produktion)                  │
│   │      └─ Regelbaserede fortolkere (demo)                 │
│   ├─ Agenter: Customer/Order, Dispatch, Routing,            │
│   │           Driver, Logistics/Monitoring                  │
│   └─ Backup, GDPR-opbevaring, PIN-adgangskontrol            │
│  API (createApi) ◄── IPC (preload, contextIsolation)        │
└─────────────────────────────────────────────────────────────┘
                 ▲ invoke / live-emner
┌────────────── Renderer (React, sandboxed) ──────────────────┐
│  Sider: Dashboard, Ordrer, Samtaler, Chauffører, Logistik,  │
│  Produkter, AI Control Center, Hændelser, Indstillinger …   │
└─────────────────────────────────────────────────────────────┘
```

Backend (`src/server`) kender ikke til Electron og kan derfor testes i Node og
køres af dev-webserveren (`src/devserver`). Kun `src/main` importerer Electron.

## Mapper

| Sti | Indhold |
|---|---|
| `src/shared` | Typer delt mellem backend og UI |
| `src/core` | Ren forretningslogik uden IO: tilstandsmaskine, priser, telefonnumre, geo, åbningstider |
| `src/server/db` | Database, migrationer |
| `src/server/services` | Datatjenester (katalog, lager, samtaler, ordrer, chauffører, kort) |
| `src/server/adapters` | Udskiftelige integrationer: `sms`, `telegram`, `maps`, `ai` |
| `src/server/gateways` | Forbinder adaptere med systemet (dubletkontrol, outbox, status) |
| `src/server/ai` | Skemaer, AI-gateway, fortolkere |
| `src/server/agents` | Agentmodulerne |
| `src/server/demo` | Demodata og simulator |
| `src/main` | Electron main/preload, Keychain-nøglelager |
| `src/renderer` | React-UI |
| `tests` | Vitest-tests |

## Agentmoduler

Modulerne er **ikke** seks separate AI-processer. Sprogmodellen bruges kun, hvor
den tilfører værdi (fortolkning af fri tekst). Alt andet er deterministisk kode.

| Modul | Fil | AI? | Ansvar |
|---|---|---|---|
| A. Customer Agent | `agents/customerAgent.ts` | Ja (fortolkning) | Samler kundens beskeder, fortolker, formulerer svar ud fra skabeloner |
| B. Order Agent | samme fil (`apply`, `advanceDraft`) | Nej | Opretter/ændrer kladder, priser fra katalog, lagerkontrol, reservation, bekræftelse, annullering |
| C. Dispatch Agent | `agents/dispatchAgent.ts` | Nej | Rangerer chauffører (ETA, lager i bil, arbejdsbyrde, løfter), sender tilbud, tildeler |
| D. Logistics Agent | `agents/logisticsAgent.ts`, `agents/routing.ts` | Nej | Ruter (billigste indsættelse med vægtning af leveringsløfter), forsinkelser, omfordelingsforslag, udløbne tilbud |
| E. Driver Communication Agent | `agents/driverAgent.ts` | Ja (kun fritekst) | Knapper/kommandoer deterministisk; fritekst fortolkes; handlinger valideres mod chaufførens ordrer |
| F. Monitoring Agent | `logisticsAgent.monitor`, `IntegrationRegistry`, `EventLog` | Nej | Integrationsstatus, usikre beskeder, ventende kunder, fejlede jobs, budget |

### AI-sikkerhedsregler

- AI'en returnerer **kun strukturerede fortolkninger** (Zod-skema + Claude structured outputs).
- Fortolkningen **valideres** (`sanitizeCustomerInterpretation`): ukendte SKU'er afvises, antal begrænses, AI-tekster med beløb fjernes.
- Priser, totaler og tider i kundebeskeder kommer altid fra systemets data (`agents/replies.ts`).
- AI kan ikke markere en levering som afsluttet: tilstandsmaskinen tillader kun `driver`/`staff` at sætte `delivered`.
- Ordrenumre gættes aldrig – er en chaufførbesked tvetydig, spørges der.
- Lav sikkerhed → én eskalering til større model → ellers overdragelse til medarbejder.

## Dataflow: kunde-SMS → levering

1. `SmsAdapter` modtager besked → `SmsGateway.ingestInbound` registrerer (unik GUID = dubletkontrol).
2. Hændelse `inbound_message` → job `process_conversation` (dedupe pr. samtale + 1,5 s debounce, så flere hurtige SMS behandles som én tur).
3. Customer Agent: tjek AI-tilstand, automatik, åbningstid → AI-fortolkning + geokodning (asynkront).
4. **Én synkron SQLite-transaktion**: anvend fortolkning, ændr ordre, reservér lager, læg svar i outbox (idempotensnøgle `reply:<samtale>:<sidste besked>`), markér beskeder behandlet.
5. Job `send_sms`: kontroller AI-tilstand igen lige før afsendelse → `sending` gemmes → adapter sender → `sent/confirmed/uncertain`.
6. Kunden svarer "ja" → `confirmed` → `awaiting_driver` → job `dispatch_order`.
7. Dispatch rangerer chauffører, sender Telegram-tilbud med knapper, timeout-job.
8. Accept → reservation flyttes atomisk til bilen (eller centrallager-afhentning) → `driver_assigned` → rute og ETA beregnes → chauffør og kunde informeres.
9. Chaufførknapper/tekst: kører nu → fremme → leveret (lager fradrages, kunden informeres).

## Ordretilstandsmaskine

`src/core/orderStateMachine.ts`. Statusser: Ny henvendelse, Afventer kundeoplysninger,
Afventer lagerkontrol, Afventer bekræftelse, Bekræftet, Afventer chauffør, Tildelt
chauffør, Under levering, Leveret, Annulleret, Kræver manuel behandling.
Alle statusskift går gennem `OrderService.transition` med optimistisk låsning
(`version`) og hændelseslog (`order_events`). Lagerkonsekvenser (frigivelse ved
annullering, fradrag ved levering) udføres i samme transaktion.

## Pålidelighed

| Mekanisme | Hvor |
|---|---|
| Vedvarende jobkø med retries, eksponentiel backoff, dedupe og lanes | `jobs/jobQueue.ts` |
| Idempotens: indgående GUID, Telegram update-ID, outbox-nøgler, kladde-nøgler | gateways, services |
| Crash-sikker afsendelse: `sending` gemmes før afsendelse; efter genstart → `uncertain`, aldrig gensendt | `SmsGateway.recoverAfterRestart` |
| Konservativ klassificering af afsendelsesfejl (kun bevist ikke-afsendt prøves igen) | `imsgRpc.classifySendError`, `botApi.sendMessage` |
| Genoptagelse: SMS-cursor og Telegram-offset gemmes i `kv_state` | gateways |
| Automatisk genstart af imsg-processen med backoff | `ImsgRpcSmsAdapter` |
| Gamle automatiske svar (>15 min) sendes ikke efter nedbrud | `SmsGateway.handleSendJob` |
| CHECK-constraints: lager kan ikke blive negativt eller over-reserveret | migration 1 |
| Backup før migrationer; automatisk og manuel backup; sikker gendannelse ved opstart | `app.ts`, `maintenance.ts` |
| Fallback til luftlinjeestimater ved kortfejl – markeres og loves ikke til kunder | `MapsService` |
| Hændelsesdrevet; kun ét let deterministisk tjek pr. minut (ingen AI-polling) | `LogisticsAgent.tick` |

## Omkostningsstyring (AI)

- Modelvalg pr. opgavetype (`settings.ai.routing`), fallback-modeller ved utilgængelighed.
- Standard: `claude-haiku-5-5` til simple fortolkninger, `claude-opus-5-5` kun ved eskalering.
- Kontekst begrænses (`maxContextMessages`, tekstlængde), telefonnumre sendes ikke.
- Stabilt systemprompt + katalog først → prompt caching (`cache_control`).
- Tokenforbrug, cache-tokens, latenstid og estimeret pris logges pr. kald (`ai_calls`).
- Månedsbudget med advarsel og hårdt stop.
- Modelpriser er konfiguration – ingen hardcodede antagelser om tilgængelige modeller (Test-knap henter faktiske modeller).

## Tilstande: Demo og produktion

Hver tilstand har sin egen database (`<datamappe>/demo/…`, `<datamappe>/production/…`).
I Demo Mode bruges kun simulerede adaptere; Demo-simulatoren nægter at starte med
rigtige adaptere. Produktion starter med automatik slået fra.
