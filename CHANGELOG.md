# Changelog

## [0.1.0] – 2026-11-09

Første version (Etape 1 og 2 samt store dele af 3–5).

### Tilføjet
- Electron + TypeScript + React + SQLite-projekt med build- og testopsætning.
- SQLite-skema med migrationssystem, CHECK-constraints for lager og backup før migration.
- Ordretilstandsmaskine med 11 statusser, aktørregler og hændelseslog.
- Deterministisk prisberegning i øre (leveringsgebyr, gratis levering, mindstekøb).
- Lager med centrallager og billagre: reservation, frigivelse, fradrag, flytning, overførsel, regulering.
- Vedvarende jobkø med dedupe, lanes, retries og backoff.
- SMS-adapter til Apple Messages via imsg (`imsg rpc`) + SMS-simulator.
- Telegram Bot API-adapter (long polling, knapper, live-position) + simulator.
- Google Maps-adapter (Geocoding, Routes Matrix) + simulator og cache.
- Claude-adapter (officielt SDK, strukturerede outputs) og AI-gateway med modelvalg, fallback, budget og forbrugslogning.
- Agenter: Customer/Order, Dispatch, Routing, Driver Communication, Logistics/Monitoring.
- Human Takeover med fire AI-tilstande og registrering af manuelle svar.
- Crash-sikker outbox: usikre afsendelser gensendes aldrig.
- Backup/gendannelse, GDPR-opbevaring, eksport og anonymisering, administrator-PIN, auditlog.
- Keychain-baseret nøglelager (Electron safeStorage).
- Komplet kontrolpanel, opsætningsguide og Demo-konsol.
- Demo Mode med separat database, fiktive data og simulerede kunder/chauffører.
- 75 automatiske tests.
- Dokumentation: README, ARCHITECTURE, INTEGRATIONS, SECURITY, TESTING, INSTALLATION, DEVELOPMENT_PLAN.
