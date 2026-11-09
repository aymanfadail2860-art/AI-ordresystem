# Arbejdsstatus (midlertidig – fjernes når Etape 1 er færdig)

Pauseret efter brugerens ønske. Fortsæt herfra.

## Færdigt (skrevet, typechecker)
- Projektopsætning: Electron + TypeScript + React + better-sqlite3, vite, vitest, esbuild (`scripts/build-main.mjs`)
- `src/shared/types.ts` – domænetyper, statusser, indstillinger
- `src/core/` – ordretilstandsmaskine, prisberegning, telefonnormalisering, geo, åbningstider, beløb
- `src/server/db/` – SQLite-skema (migration 1) + migrationssystem
- `src/server/infra.ts` – hændelsesbus, indstillinger, hændelseslog, integrationsstatus, kv, audit
- `src/server/jobs/jobQueue.ts` – vedvarende jobkø (dedupe, lanes, backoff)
- Adaptere: SMS (imsg RPC + simulator), Telegram (Bot API + simulator), Maps (Google + simulator), Claude (SDK, strukturerede outputs)
- Services: katalog, lager (reservation/frigivelse/fradrag/flyt), samtaler, ordrer, chauffører, kort (cache)
- AI: skemaer, gateway (budget, modelvalg, fallback, logning), Claude- og regelbaserede fortolkere
- Gateways: SMS (outbox, crash-sikker, manuel-aktivitet), Telegram
- `src/server/agents/replies.ts`, `src/server/context.ts`

## Næste skridt
1. Agenter: customerAgent (ordre-agent i sync-transaktion), dispatch, routing, logistics, driverComm, monitoring
2. Demo: seed-data + simulator (kunde-/chaufførbots)
3. App-komposition (createApp), API-lag, auth (PIN), backup, retention
4. Electron main/preload + safeStorage-hemmeligheder; dev-webserver
5. React UI: Dashboard, Ordrer, Samtaler, Chauffører, Logistik, Produkter, AI Control Center, Indstillinger, Opsætningsguide, Demo-konsol
6. Tests (vitest) + dokumentation (README, ARCHITECTURE, DEVELOPMENT_PLAN, INTEGRATIONS, SECURITY, TESTING, INSTALLATION, CHANGELOG, .env.example)

## Research-konklusion (SMS)
imsg (openclaw/imsg, MIT, aktivt vedligeholdt, `imsg rpc` med eksplicitte
afsendelses-dispositioner not_started/may_have_completed/still_in_flight) valgt som
SMS-backend. imessage-bridge (Python HTTP, nyere, én vedligeholder, ingen RCS) fravalgt.
