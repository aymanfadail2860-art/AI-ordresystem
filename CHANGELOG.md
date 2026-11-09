# Changelog

## [0.2.0] – 2026-11-09

Arkitekturændring: Telegram-baseret ETA, intelligent ruteplanlægning og omsætningsoptimering.

### Ændret
- **Ingen live-GPS-tracking.** Telegram-positioner gemmes ikke. Chaufførens "senest kendte stop" (seneste levering/centrallager/startsted) bruges kun til køretidsberegning.
- Ruter er nu bindende: rækkefølgen ændres kun via accepteret ruteplan, chaufførens egen melding eller levering/annullering. Ruteversion forhindrer, at forældede planer anvendes.
- Dispatch vælger chauffør og placering med en økonomisk beslutningsmodel i stedet for korteste ETA.
- Højst ét ubesvaret tilbud pr. chauffør; ventende ordrer prioriteres efter dækningsbidrag og ventetid.
- Logistik-siden er omskrevet; funktioner der antydede live-GPS er fjernet.

### Tilføjet
- ETA-motor med anker (chaufførmelding/levering/afgang), meldte forsinkelser, historisk tillæg, interval og sikkerhed.
- Fortolkning af chaufførbeskeder: ETA-melding, forsinkelse (rute eller ordre), "færdig med X og kører mod Y", ekstra kapacitet, opklarende spørgsmål ved uklarhed.
- Kundeopdateringer: "stå klar"-besked, ETA-ændringer med konfigurerbare grænser, minimumsinterval og maks. antal; aldrig opdigtede tider.
- Statusforespørgsel til chauffører uden status og eskalering til medarbejder.
- Økonomisk model: dækningsbidrag (vareomkostning på produkter), køretid, vægtet ventetid, løfter, risiko, omfordelingsomkostning, nærhed; hårde begrænsninger.
- Omfordelingsforslag med økonomisk begrundelse; anvendelse sender tilbud, som den nye chauffør skal acceptere.
- Indstillinger → Logistik og økonomi.
- Migration 2 og 15 nye logistiktests (i alt 90).

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
