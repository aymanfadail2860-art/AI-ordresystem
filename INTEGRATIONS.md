# Integrationer

Alle integrationer ligger bag udskiftelige adaptere i `src/server/adapters/` og
har en simuleret udgave til Demo Mode og tests. **En simuleret integration
præsenteres aldrig som en produktionsintegration** – UI'et viser "Simuleret", og
integrationsstatus har feltet `productionVerified`, som først må sættes, når den
relevante hardware-/kontotest er gennemført.

| Integration | Adapter | Status |
|---|---|---|
| SMS (Apple Messages) | `sms/imsgRpc.ts` | Implementeret, testet mod falsk imsg-proces. **Ikke verificeret på hardware.** |
| Telegram | `telegram/botApi.ts` | Implementeret, testet mod mocket HTTP. **Kræver rigtig bot.** |
| Google Maps | `maps/google.ts` | Implementeret, testet mod mocket HTTP. **Kræver rigtig nøgle.** |
| Claude API | `ai/claude.ts` | Implementeret med officielt SDK. **Kræver rigtig nøgle og prompt-evaluering.** |

---

## 1. Apple Messages og SMS (kritisk afhængighed)

### Begreber – de er ikke det samme

| | Hvad det er | Konsekvens for AI Dispatch |
|---|---|---|
| **iMessage** | Apples egen tjeneste over internettet (blå bobler). Virker direkte på Mac'en via Apple-kontoen. | Kunder med iPhone kan ende på iMessage i stedet for SMS. Det virker også, men er en anden kanal. |
| **SMS** | Almindelig mobil-SMS via teleselskabet (grønne bobler). Kan **kun** sendes/modtages af iPhonen med SIM-kortet. | Mac'en kan kun bruge SMS via **Videresendelse af SMS** fra iPhonen. |
| **RCS** | Ny standard (iOS 18+), afhænger af teleselskab. Videresendes også til Mac via iPhonen. | imsg accepterer SMS- eller RCS-kvitteringer ved `--service sms`. Dansk teleselskabs-understøttelse skal verificeres. |
| **Videresendelse af SMS** (Text Message Forwarding) | iPhone videresender SMS/RCS til Mac og sender Mac'ens SMS ud via iPhonen. | **iPhonen skal være tændt og online.** Er den slukket/uden net, kan Mac'en ikke sende eller modtage SMS. |

En løsning, der virker med iMessage, virker **ikke** automatisk med SMS. Begge dele
skal testes særskilt.

### Undersøgte løsninger (november 2026)

| | [openclaw/imsg](https://github.com/openclaw/imsg) | [greghughespdx/imessage-bridge](https://github.com/greghughespdx/imessage-bridge) |
|---|---|---|
| Teknik | Swift CLI. Læser `~/Library/Messages/chat.db` read-only; sender via Messages.app's AppleScript. JSON-RPC over stdin/stdout (`imsg rpc`). | Python HTTP-server (~200 linjer) + Claude Code Channels-plugin. Læser chat.db; sender via AppleScript. |
| Licens | MIT | MIT |
| Vedligeholdelse | Meget aktiv (v0.21.0, 5. nov. 2026), CI, signerede/notariserede universal-binærer | Aktiv men ung (første commit marts 2026, én vedligeholder, ~36 commits) |
| SMS | Ja, `--service sms` (kræver videresendelse). RCS accepteres. | Ja (SMS/MMS), **RCS ikke understøttet** |
| Leveringssikkerhed | Hver tekstafsendelse verificeres mod chat.db (8 s). Fejl har eksplicit disposition: `not_started` (sikkert at gentage), `may_have_completed` / `still_in_flight` (gentag aldrig). Beskytter mod macOS 26 "ghost row"-fejl. | Idempotensnøgle på `/send`, bekræftelse mod chat.db, `retry_safe`-felt. |
| Overvågning | `watch.subscribe` med cursor (`since_rowid`), debounce, overflow-håndtering, polling-fallback | HTTP-polling |
| Krav | macOS 14+, Fuld diskadgang, Automation → Messages | Python 3, Fuld diskadgang, Automation |
| Privat API / SIP | Nej for læs/send (kun valgfri avancerede funktioner) | Nej |

**Valg: imsg via `imsg rpc`.** Begrundelse: moden og aktiv, eksplicitte
leverings-dispositioner der matcher kravet "send aldrig, hvis det er usikkert",
RCS-understøttelse, langtkørende proces uden netværksport, og signerede binærer
der kan følge med installationen (ingen Terminal hos kunden).

Adapteren (`src/server/adapters/sms/imsgRpc.ts`):
- Starter `imsg rpc` som child process, kalder `initialize` og `watch.subscribe` fra gemt cursor.
- Indgående: `is_from_me=false` → `InboundSms`; gruppechats ignoreres; redigeringer/tilbagekaldelser ændrer ikke ordrer.
- Udgående observeret (`is_from_me=true`) → matches mod systemets egne beskeder (GUID, ellers tekst inden for 3 min). Ukendte = sandsynligvis manuelt svar fra en medarbejder.
- Afsendelse: `send` med `service: "sms"`, `region: "DK"`. Kun `ok:true` = sendt; `retry_safe:true`/valideringsfejl = ikke sendt; alt andet (timeout, procesnedbrud, `-32001`) = **usikker**.
- Procesnedbrud → automatisk genstart med eksponentiel backoff; alle ventende afsendelser markeres usikre.

### Kendte begrænsninger og risici

1. **iPhonen er et kritisk led.** Den skal være tændt, online og logget ind på samme Apple-konto. Overvej strømforsyning og fast Wi-Fi.
2. **Mac'en skal være vågen og logget ind** (Messages.app kører i brugersessionen). Slå dvale fra, og aktivér automatisk login efter strømsvigt.
3. **Hvilket nummer sendes fra?** Messages' AppleScript kan ikke tvinge et bestemt afsendernummer, hvis flere numre deler Apple-konto (imsg-dokumentation).
4. **iMessage-kunder:** Med `service: sms` sendes altid SMS. Kunder, der skriver via iMessage, modtages fint, men svar sendes som SMS (kan vælges om til `auto`).
5. **Manuelle svar fra iPhonen:** Udgående SMS skrevet på iPhonen *bør* synkroniseres til Mac'ens chat.db (videresendelse/Beskeder i iCloud), men **dette er ikke verificeret**. Indtil PoC trin 7 er bestået, skal medarbejdere trykke **"Overtag samtale"** i AI Dispatch før de svarer fra iPhonen. Registrering af ukendte udgående beskeder er en ekstra sikkerhed (sætter samtalen til manuel), ikke den primære mekanisme.
6. **Tilladelser (TCC):** Fuld diskadgang og Automation tildeles til AI Dispatch.app (den ansvarlige proces for imsg-child-processen). Skal verificeres på hardware.
7. **Omkostninger:** SMS sendes via virksomhedens mobilabonnement.
8. **Apple-betingelser:** Automatisering af Beskeder via AppleScript er en dokumenteret, offentlig funktion, men Apple garanterer ikke stabilitet mellem macOS-versioner. Test efter hver macOS-opdatering.

### Proof of Concept – SKAL gennemføres på rigtig hardware

Udstyr: virksomhedens iPhone (SIM), Mac med AI Dispatch, en ekstern testtelefon
(gerne én Android, så SMS ikke bliver til iMessage).

Forberedelse:
1. iPhone: Indstillinger → Beskeder → Videresendelse af SMS → slå Mac'en til.
2. Mac: Beskeder logget ind på samme Apple-konto. Kontroller, at en SMS fra testtelefonen vises på Mac'en.
3. Installér imsg, giv AI Dispatch Fuld diskadgang. Start AI Dispatch i **produktion** med automatik **slået fra**.
4. Opret testtelefonens nummer som kunde; aktivér automatik kun for testen.

| # | Test | Forventet | Resultat |
|---|---|---|---|
| 1 | Testtelefon sender SMS "test 1" til virksomhedens nummer | Vises i Beskeder på iPhone | ☐ |
| 2 | — | Vises i Beskeder på Mac | ☐ |
| 3 | — | Vises i AI Dispatch → Kundesamtaler (én gang) | ☐ |
| 4 | AI Dispatch sender svar | Status "bekræftet"; testtelefonen modtager **SMS** (grøn) | ☐ |
| 5 | — | Svaret ses i samme samtale på iPhone | ☐ |
| 6 | Medarbejder svarer manuelt fra iPhone | Testtelefonen modtager svaret | ☐ |
| 7 | — | AI Dispatch viser beskeden som "Medarbejder" og sætter samtalen til "Manuel overtagelse" | ☐ |
| 8 | Send 3 SMS hurtigt efter hinanden | Ét samlet svar, ingen dobbeltsvar | ☐ |
| 9 | Sluk iPhonens netværk, lad AI svare | Ingen falsk "sendt"; besked usikker/ikke sendt; advarsel vises | ☐ |
| 10 | Genstart Mac midt i drift | Ingen beskeder gensendes; cursor genoptages; nye SMS modtages | ☐ |
| 11 | Kunde med iMessage skriver | Modtages; svar sendes som SMS (eller iMessage ved `auto`) | ☐ |
| 12 | RCS (hvis teleselskabet understøtter det) | Modtages og besvares | ☐ |

**Hvis trin 7 fejler:** Programmet kører videre med eksplicit manuel overtagelse
(knappen i UI) – det påstår ikke automatisk detektion. Slå
"Sæt samtale til manuel, når en manuel besked registreres" fra, og instruér
medarbejderne.

**Hvis trin 4–5 fejler generelt:** SMS-integrationen erklæres ikke produktionsklar.
Systemet kan stadig køres med Demo/simulator, og alternativer vurderes (fx native
chat.db-læser + AppleScript i egen kode, eller en dedikeret Mac + iPhone).

---

## 2. Telegram Bot API

- Long polling (`getUpdates`) – ingen offentlig webhook eller port nødvendig. Offset gemmes → ingen tab eller dubletter efter genstart.
- Chauffører knyttes via engangskode: kontoret ser koden under Chauffører, chaufføren skriver `/start KODE` til botten.
- Inline-knapper: Accepter/Afvis tilbud (tilbuddet viser placering i ruten og evt. ruteændring); Kører mod denne / Der om 5 min / Fremme / Leveret / Kunden svarer ikke / +10 min.
- Kommandoer: `/online`, `/offline`, `/pause`, `/status` (viser ruten med ETA'er), `/ekstra` (kan tage en ekstra ordre).
- Fritekst ("Jeg er fremme", "Kunden svarer ikke", "Jeg bliver 15 minutter forsinket", "Jeg har ikke flere Red Bull", "Ordre 142 er leveret") fortolkes og valideres mod chaufførens ordrer.
- **Ingen live-GPS:** AI Dispatch tracker bevidst ikke chaufførernes position. Delte positioner fra Telegram gemmes ikke (chaufføren får besked om at skrive status i stedet). ETA'er bygger på chaufførens meldinger, bekræftede leveringer, planlagte ruter og køretider – se ARCHITECTURE.md → Logistik uden live-GPS.
- **Statusmeldinger der forstås** (eksempler): "Ordre 142, jeg er der om 5 min", "Jeg er 10 min forsinket" (gælder hele den resterende rute), "Jeg er færdig med 142 og kører mod 143", "Der er trafik, bliver nok 20 min senere", "Jeg kan godt tage en ekstra ordre på vejen". Uklare beskeder besvares med et opklarende spørgsmål; ordrenumre gættes aldrig.
- **Statusforespørgsel:** Har en chauffør med aktive ordrer ikke givet status i N minutter, spørger botten; svares der stadig ikke, eskaleres til kontoret.
- Fælles chaufførgruppe: feltet findes i indstillingerne (`telegram.driverGroupChatId`); udsendelse til gruppe er planlagt (Etape 4).

Opsætning: @BotFather → `/newbot` → token → Indstillinger → Integrationer.

## 3. Google Maps Platform

| Behov | API | Brug |
|---|---|---|
| Adressevalidering / geokodning | Geocoding API | `region=dk`, `components=country:DK`; upræcise resultater (uden husnummer / APPROXIMATE / partial_match) kræver præcisering fra kunden |
| Køretider med trafik | Routes API `computeRouteMatrix` (`TRAFFIC_AWARE`) | Én matrix pr. ruteberegning |
| Ruteoptimering | Lokal økonomisk indsættelsesmodel | Undgår dyr Route Optimization API; respekterer bindende ruter og givne løfter |

Caching: geokodning 14 dage, køretider 10 min (koordinater afrundet til ~11 m).
Ved fejl: luftlinjeestimat × vejfaktor, markeret `fallback` → kommunikeres ikke som løfte.
Mulig udvidelse: Address Validation API, Route Optimization API ved mange chauffører.

Nøgle: aktivér Geocoding API og Routes API; begræns nøglen til disse.

## 4. Claude API

- Officielt SDK `@anthropic-ai/sdk`, `messages.parse` med Zod-skema (`output_config.format`), `effort: low` for rutinefortolkning.
- Standardmodeller: `claude-haiku-5-5` (kundebeskeder, chaufførbeskeder), `claude-opus-5-5` (eskalering ved lav sikkerhed), fallback `claude-sonnet-5-5`. Alt kan ændres i AI Control Center; "Hent tilgængelige modeller" kalder Models API.
- `stop_reason: refusal` → beskeden sendes til en medarbejder (ingen server-side fallback; en afvist kundebesked bør altid ses af et menneske).
- SDK'et gentager automatisk 408/409/429/5xx; derudover gentager jobkøen og overdrager til medarbejder efter 3 forsøg.
- Virksomheden bruger sin egen nøgle – programmet afhænger ikke af udviklerens konto.
- **Før drift:** kør et evalueringssæt med rigtige (anonymiserede) danske kundebeskeder for at måle fortolkningskvalitet og omkostning pr. ordre.
