# Changelog

## [0.5.0] – 2026-11-10

Etape 5: kundeaccept af alternative leveringstider, fysisk lagerkapacitet og cloud-kvalitetssikring. Hybridstrategien er fortsat standard; dispatchvægtene er ikke ændret. Analyse og resultater: `docs/simulation/v0.5/`.

### Tilføjet
- **Alternative leveringstider via SMS:** realistisk tidsrum ("omkring kl. 21.15–21.30. Passer det dig?"), reservation i chaufførens kø, udløb, genvalidering ved accept, deterministisk fortolkning af "Ja", "Det er fint", "Kan I komme kl. 22?", "Nej, det er for sent", "Hvad er det tidligste?"; nyt forslag eller medarbejder ved ændret kapacitet, afslag, intet eller uklart svar. Aftalt tidsrum gemmes på ordren og respekteres af dispatch.
- Intern kø uden kundekontakt (slået fra som standard – ingen målbar gevinst i simuleringen).
- **Fysisk lagerkapacitet:** lagerenheder pr. vare, kapacitet pr. bil og pr. varetype, fast sortiment med normalbeholdning/maks., flex-plads, status for brugt/reserveret/fri plads; håndhæves ved overførsel, afhentning og dispatch.
- **Kapacitetsbegrænset opfyldning:** dækker kun ordrer, der kan være i bilen; påfyldning prioriteret (dækkede leveringer → aftalte senere leveringer → efterspørgsel efter DB pr. lagerenhed) med begrundelse og fravalg i ledelsesgruppen.
- Kontrolpanel: aftalt tidsrum på ordren, alternative tider under Drift og overvågning, bilernes kapacitet under Billager, plads pr. vare i produktformularen. Demo-konsol: 5 varianter af alternative tider og et kapacitetsscenarie.
- Simulering: kunde-bots svarer på tidsforslag, bilerne har fysisk kapacitet; `--v041` og `--no-alternatives`; nye nøgletal (tilbudt/accepteret/overholdt, manuelle sager pr. årsag, kapacitetsproblemer).
- Migration 5. 29 nye tests (i alt 188).

### Rettet
- Ved gentildeling (fx omfordeling) blev kundens lovede tidspunkt overskrevet i stilhed – forsinkelser i forhold til det reelle løfte blev skjult.
- Ordrer, der ikke kan være i nogen bil, ventede forgæves; de går nu straks til en medarbejder.
- Overvågningen talte planlagte ordrer (aftalt tidsrum/afventende svar) som manglende kapacitet.

### Kendte negative effekter (simulering)
- Den realistiske kapacitetsmodel giver færre leverede ordrer end v0.4.1's ubegrænsede biler (−24 ved 1.000 ordrer).
- Alternative tider gav lidt flere manuelle sager og forsinkelsesminutter ved 1.000 ordrer (kapaciteten er opbrugt til lukketid); lille gevinst ved 500 ordrer.


## [0.4.1] – 2026-11-10

Etape 4.1: forbedret dispatchstrategi ud fra simuleringsresultaterne. Årsagsanalyse og resultater: `docs/simulation/v0.4.1/`.

### Tilføjet
- **Adaptiv hybridstrategi** (ny standard): belastning målt i kapacitet med hysterese; lav = hurtigst levering, mellem = mindst køretid med stærk løftebeskyttelse, høj = kapacitet først; lovede leveringer rykkes ikke (lav) eller kun kort og med margin (mellem/høj); mindst skadelige fallback i stedet for afvisning; værdivægt højst 1,25×; foretrækker chauffører med varerne eller et planlagt lagerbesøg.
- **Påfyldning ved lagerbesøg** ud fra de seneste 2 timers salg (godkendes sammen med opfyldningen).
- Overvågningen tæller samme beslutning én gang (`monitoring.dedupeLinkedDecisions`).
- Simuleringsmatrix (`npm run simulate:matrix`) med 4 profiler (ordrestørrelser, adresser, varebehov), gennemsnit/spredning/dårligste; nye nøgletal: forsinkelsesminutter, P90 forsinkelse, ETA-ændringer, rykkede løfter, åbne ordrer ved dagens slutning, indgreb pr. årsag, løftediagnostik pr. ruteposition.
- Kontrolpanel: valg af dispatchstrategi og adaptive grænser (Indstillinger → Logistik og økonomi); aktuel strategi og belastning under Drift og overvågning.
- 12 nye regressionstests (i alt 159).

### Rettet
- **Simuleringens chauffør-bot genbesøgte leverede ordrer** (ca. 4–5 min spildt pr. stop) – v0.4.0-simuleringerne var derfor kunstigt overbelastede. Forsinkelse måles nu ved ankomst (det kunden får lovet).
- Forberedte SQL-sætninger genbruges (simuleringen er ca. 5× hurtigere).

### Ændret
- Standardstrategi: `adaptive` (den økonomiske strategi kan stadig vælges). De oprindelige logistiktests kører eksplicit med `economic`, og to overvågningstests med v0.4.0-adfærden.


## [0.4.0] – 2026-11-10

Etape 4: automatiske ledelsesrapporter, proaktiv overvågning og fuld driftssimulering. Arkitektur, Demo Mode og sikkerhedsregler er bevaret.

### Tilføjet
- **Timerapporter** til ledelsesgruppen hver hele time i åbningstiden (omsætning, dækningsbidrag, ordrer, leveringstid, forsinkelser, lager, godkendelser, AI-budget, driftsvurdering). Alle tal fra databasen, ingen AI. Idempotente (én pr. periode), crash-sikre, Europe/Copenhagen med sommer-/vintertid. Rapport på forespørgsel i gruppen og fra kontrolpanelet.
- **Proaktiv ledelsesassistent**: kritiske forsinkelser, chauffører der ikke svarer, manglende kapacitet, lagerunderskud, godkendelser der udløber, ændringer i ordretilgang, integrationsfejl og risiko for løftebrud – klassificeret A/B/C/D, uden gentagne advarsler, med beslutningslog.
- **Dispatchstrategier** til sammenligning: først-til-mølle, korteste ekstra køretid, økonomisk (standard).
- **Hel-dags-driftssimulering** med fast seed (300 ordrer, 8 chauffører, fejlvinduer), `npm run simulate`, worker-tråd og resultater i `docs/simulation/`.
- Kontrolpanel: **Drift og overvågning** (oversigt, timerapporter, advarsler, kritiske hændelser, integrationer, simulering og strategisammenligning – markeret som simuleret). Demo-konsol: rapport og simuleret Telegram-udfald.
- Virtuelt ur (`clock.ts`) og tidszonehjælpere (`core/time.ts`); `company.timezone`.
- Migration 4 (`management_reports`, `monitor_alerts`, `monitor_decisions`, `simulation_runs`), indstillinger `monitoring`, `management.hourlyReports`, `economics.strategy`.
- 34 nye tests (i alt 147).

### Rettet (fundet i Etape 4)
- **Periodiske jobs stoppede efter første kørsel** (logistikkens minuttjek, opfyldningstjek, backup, dataopbevaring): de gen-planlagde sig selv, mens de kørte, og blev afvist af dedupe-indekset. Nyt `JobQueue.registerRecurring`.
- **Opfyldningsforslag udløb straks og blev genskabt i en løkke**, når det sikre punkt var "før første stop" (deadline = nu). Ledelsen har nu altid mindst 10 min; hastende forslag markeres.
- **Telegram-beskeder blev opgivet efter ca. 30 s udfald**; de venter nu op til ca. 35 min og markeres fejlet bagefter i stedet for at stå som "i kø".
- Ledelsesbesked i "sending" ved nedbrud markeres nu usikker (gensendes aldrig).
- **Ledelseshandlinger** overtages atomisk ved bekræftelse; en afbrudt udførelse markeres usikker og gentages ikke.
- Ledelsen kunne ikke få rapport/svar uden Claude API – regelbaseret reserve.
- Demo-fortolkeren fandt ikke adressen i "Kan I levere 2 … til Lærkevej 12" (kun første mønster blev prøvet), og vejnavne som "Egeallé"/"Rosenvænget" blev ikke genkendt ved afgrænsning.
- "I dag", månedsbudget og åbningstider brugte maskinens tidszone – nu virksomhedens.
- Dispatch-job døde efter 5 forsøg ved midlertidig mangel på chauffør (skabte støj i fejllisten).


## [0.3.0] – 2026-11-10

Udvidelse: interaktiv ledelsesagent og proaktiv lageropfyldning. Arkitektur, Demo Mode og eksisterende tests er bevaret.

### Tilføjet
- **Ledelsesgruppe i Telegram:** spørgsmål (omsætning, manglende ordrer, chaufførstatus, mest forsinket, billager, lagerproblemer, "hvorfor", ruteøkonomi, rapport) besvares fra databasen; handlinger (omfordel, prioritér, bedre rute, pause/genoptag, manuel behandling, godkend/afvis opfyldning, automatik, regler) udføres via eksisterende services.
- Roller Administrator/Leder/Observatør, verifikation af chat-ID og Telegram-bruger-ID, tilknytning med `/leder KODE`.
- Eksplicit bekræftelse via knapper (kun udsteder eller administrator, med udløb); AI'en kan ikke godkende egne handlinger.
- Revisionsspor (`management_commands`) og gruppebeskedlog (`management_messages`).
- **Proaktiv lageropfyldning:** billagerprognose efter hvert stop, underskud, økonomisk valg af opfyldningspunkt og lager, sidste sikre beslutningstidspunkt, godkendelse med Godkend/Vis alternativer/Afvis, chaufføraccept, afhentning, påmindelse, eskalering og udløb.
- Prioriterede ordrer (`orders.priority`) og pause (`orders.paused_from_status`); ruteændringstilbud (`route_change`) til chaufføren.
- Chaufførens lagermelding med antal ("har kun 4 cola tilbage") afstemmer billageret.
- Kontrolpanel: Ledelsescenter (godkendelser, kommandolog, gruppechat, ledere), Produkter → Billager og opfyldning, opfyldningsstatus i Logistik, Demo-konsol med ledelsesgruppe og opfyldningsscenarie.
- Migration 3 og 23 nye tests (i alt 113).


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
