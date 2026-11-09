# Sikkerhed og databeskyttelse

## API-nøgler

- Gemmes **aldrig** i SQLite-databasen, kildekoden, logs eller `.env` i drift.
- Electron `safeStorage` krypterer nøglerne; på macOS ligger krypteringsnøglen i brugerens **Nøglering (Keychain)**. Den krypterede fil (`secrets.enc.json`, mode 600) ligger i app-datamappen.
- Er sikker lagring ikke tilgængelig, nægter programmet at gemme nøglen.
- UI'et viser kun maskerede nøgler (`sk-a…1234`). Ændring/sletning kræver administrator-PIN og logges i auditloggen.

## Adgangskontrol

- Administrator-PIN (4–8 cifre, scrypt-hash med salt, konstant-tids-sammenligning).
- Kræves til: API-nøgler, integrations-/AI-/SMS-/opbevarings-/backupindstillinger, skift til produktion, backup og gendannelse, eksport/anonymisering af kundedata, auditlog.
- Oplåsning gælder 10 minutter; kan låses manuelt.
- **Sæt PIN under opsætningen.** Uden PIN er følsomme handlinger åbne (kun tilladt under første opsætning).

## Electron-hærdning

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Preload eksponerer kun `invoke(metode, parametre)` og live-hændelser; metodenavne valideres; alle parametre valideres i API-laget.
- Content-Security-Policy: kun lokale scripts.
- Navigation blokeret; eksterne links åbnes i standardbrowseren.
- Kun én instans af programmet (forhindrer to processer på samme database/SMS-forbindelse).

## Persondata (GDPR)

AI Dispatch behandler telefonnumre, navne, adresser, leveringsinstruktioner og beskedindhold.

| Princip | Implementering |
|---|---|
| Dataminimering | Kun nødvendige felter. Telefonnumre sendes **ikke** til Claude API; kun beskedtekst, adresse og ordreindhold. |
| Opbevaringsbegrænsning | Konfigurerbart: beskedindhold slettes efter N dage (std. 180), inaktive kunder anonymiseres efter N dage (std. 730), hændelseslog slettes efter N dage (std. 90). Kører automatisk hver 6. time. |
| Indsigtsret | Eksport af alle data om en kunde (JSON) under Indstillinger → Sikkerhed. |
| Ret til sletning | Anonymisering: telefonnummer, navn, adresser og beskeder fjernes; ordrebeløb bevares til bogføring. |
| Sikkerhed | Lokal database, krypteret nøglelager, PIN, auditlog over følsomme handlinger. Anbefaling: slå FileVault til på Mac'en. |
| Logning | Fejl- og hændelseslog maskerer telefonnumre (`+45 •••• 1234`). |

### Databehandlere (virksomheden skal have aftaler)

| Leverandør | Data | Note |
|---|---|---|
| Anthropic (Claude API) | Beskedtekst, adresse, ordreindhold | Indgå databehandleraftale (DPA); vurder dataopbevaringsindstillinger på kontoen |
| Google (Maps Platform) | Leveringsadresser, koordinater | Google Maps Platform-vilkår / DPA |
| Telegram | Ordrenummer, adresse, varer, kundens navn/telefon til chaufføren | Chaufføren har brug for kontaktoplysninger for at levere; vurder om dette er acceptabelt |
| Apple (iMessage/iCloud) | Beskeder i Beskeder-appen | Som virksomhedens eksisterende brug af iPhonen |

Virksomheden er dataansvarlig og skal opdatere sin privatlivspolitik og informere kunderne om, at SMS'er behandles automatisk.

## Hvad der aldrig må committes

`.gitignore` udelukker databaser (`*.sqlite`, `data/`, `backups/`), `.env`, `secrets.json` og leverandørbinærer. Brug kun fiktive data i tests og demo (telefonserien +45 9999 xxxx).

## Rapportering af sårbarheder

Kontakt projektets ejer direkte; opret ikke offentlige issues med sårbarhedsdetaljer.
