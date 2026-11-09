# Installation

## Hos en virksomhed (A, B, C …)

Samme program installeres hos alle virksomheder. Hver installation har sin egen
database, egne API-nøgler (Keychain) og egne indstillinger i
`~/Library/Application Support/AI Dispatch/`. Ingen kodeændringer.

### Forudsætninger

- Mac med macOS 14 (Sonoma) eller nyere, der kan stå tændt og vågen.
- Virksomhedens iPhone (med SIM) på samme Apple-konto, med Videresendelse af SMS til Mac'en.
- Virksomhedens egne konti: Anthropic (Claude API-nøgle), Telegram-bot (@BotFather), Google Cloud (Maps-nøgle).

### Trin

1. Installér `AI Dispatch.dmg` (træk til Programmer). Åbn programmet – det starter i **Demo Mode**.
2. Indstillinger → System → **Skift til produktion** (separat database).
3. Følg **Opsætningsguiden** (11 trin): virksomhed, Apple Messages, Claude, Telegram, Google Maps, chauffører, produkter, lager, leveringsområde, test, aktivér.
4. Indstillinger → Sikkerhed → sæt **administrator-PIN**.
5. Systemindstillinger på Mac'en:
   - Anonymitet og sikkerhed → **Fuld diskadgang** → AI Dispatch (læsning af Beskeder).
   - Første SMS-afsendelse: tillad at AI Dispatch styrer **Beskeder**.
   - Energi: forhindr automatisk dvale; "Start automatisk efter strømsvigt".
   - Brugere og grupper: automatisk login (Beskeder kræver en aktiv brugersession).
   - Tilføj AI Dispatch under Generelt → Login-emner.
6. Gennemfør **SMS Proof of Concept** (INTEGRATIONS.md) før automatik aktiveres.
7. Slå **Automatik TIL** (sidebjælken).

Kunden skal ikke bruge Terminal eller Claude Code.

## Bygning af installationspakken (udvikler)

På en Mac med Node 22+ og **Xcode Command Line Tools** (`xcode-select --install`).
Fuld Xcode er **ikke** påkrævet.

```bash
npm ci
```

```bash
npm test
```

Læg imsg's signerede release (universal binær + ressource-bundles) i `vendor/imsg/`
(fra https://github.com/openclaw/imsg/releases – kontrollér version og checksum). Mappen er git-ignoreret.

```bash
npm run dist:mac
```

electron-builder genbygger better-sqlite3 til Electron, signerer med Hardened
Runtime + `build/entitlements.mac.plist` og notariserer.

### Signering og notarisering

Kræver Apple Developer Program-medlemskab (Developer ID Application-certifikat).

| Variabel | Formål |
|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID-certifikat (.p12) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarisering via `notarytool` |

Den medfølgende imsg-binær gensigneres med virksomhedens identitet som del af app-pakken.
Entitlement `com.apple.security.automation.apple-events` + `NSAppleEventsUsageDescription`
er nødvendige for at styre Beskeder under Hardened Runtime.

## Opdateringer

Strategi (implementeres i Etape 6):

- Releases udgives som signerede, notariserede `.dmg`/`.zip` på en privat opdateringskanal (GitHub Releases i et privat repo eller statisk HTTPS-server).
- `electron-updater` tjekker kanalen, verificerer kodesignaturen og installerer ved næste genstart – kunden skal ikke bruge Terminal.
- Opdatering udskydes, mens der er aktive leveringer eller ventende afsendelser; der tages backup før databasemigrationer (allerede implementeret).
- Migrationer er fremadkompatible; eksisterende migrationer ændres aldrig.
- Mulighed for at pinne en version pr. kunde og rulle tilbage til forrige `.dmg`.

## Backup og gendannelse

- Automatisk backup (standard hver 24. time, behold 14) i `…/production/backups/`.
- Manuel backup og gendannelse under Indstillinger → Sikkerhed (kræver PIN). Gendannelse tager først en ny backup og anvendes ved næste opstart.
- Anbefaling: Time Machine eller anden ekstern backup af hele datamappen (nøglefilen kan kun dekrypteres af samme macOS-bruger/Keychain).
