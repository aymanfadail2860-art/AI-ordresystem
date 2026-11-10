# Etape 4.1 – årsagsanalyse og ny dispatchstrategi

> **SIMULEREDE DATA.** Alle tal kommer fra driftssimuleringen i Demo Mode (simulerede
> kunder, chauffører, ledere, kort og Telegram, virtuelt ur). De beviser ikke
> ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.

| Fil | Indhold |
|---|---|
| [comparison.md](comparison.md) | Før/efter pr. belastning og alle fire strategier efter v0.4.1 (gennemsnit ± spredning, dårligste) |
| [before.md](before.md) / `before.json` | A–C med v0.4.0-regler (rettet simulator), 60 kørsler |
| [after.md](after.md) / `after.json` | A–D med v0.4.1-regler, 80 kørsler |

**Matrix:** 100/8, 150/8, 300/8, 500/10 og 1.000/16 (henvendelser/chauffører) ×
4 seeds med hver sin profil (11 standard, 23 store ordrer, 37 spredte adresser,
42 flere varer kun på centrallageret) × strategier. Alle strategier får
identiske kunder, adfærd og forretningsregler. Genskab med:

```bash
npm run simulate:matrix -- --strategies fifo,shortest_detour,economic --legacy-rules --out docs/simulation/v0.4.1/before.json
```

```bash
npm run simulate:matrix -- --strategies fifo,shortest_detour,economic,adaptive --out docs/simulation/v0.4.1/after.json
```

```bash
node scripts/sim-report.mjs
```

## 1. Fejl i simuleringen (fundet før analysen)

Inden årsagsanalysen blev simuleringen gennemgået. To fejl ramte **alle** strategier:

1. **Chauffør-botten genbesøgte leverede ordrer.** Den ryddede sin "leveret"-markering,
   før systemet havde behandlet Telegram-beskeden, og kørte derfor til samme adresse
   igen (ca. 4–5 min spildt pr. stop). Det gjorde dagen med 300 ordrer kunstigt
   overbelastet (v0.4.0: 85 min gns. leveringstid, 31 manuelle sager; rettet: 63 min, 10
   manuelle sager) og gjorde alle ETA'er systematisk 6–8 min for optimistiske pr. stop.
   **Resultaterne i `docs/simulation/` fra v0.4.0 er derfor forældede.** Regressionstest:
   `botRevisits` skal være 0, og ETA-fejlen pr. ruteposition må ikke være systematisk.
2. **Forsinkelse blev målt ved afslutning af afleveringen** (2–4 min efter ankomst), mens
   kunden får lovet ankomsttiden. Nu måles ved ankomst.

Desuden er der målebias, som *ikke* er rettet, men rapporteres:

- **Først-til-mølle giver færre løfter.** Kunder får kun et tidspunkt ved tildeling, hvis
  ETA'en er sikker nok. Bagerste stop i lange ruter er usikre, så først-til-mølle
  lover et tidspunkt til 33 % af de leverede ordrer mod 43 % for den økonomiske
  strategi (300 ordrer). Dens lave forsinkelsesprocent skyldes delvist, at færre ordrer
  har et løfte. Derfor rapporteres også forsinkelsesminutter, P90 og andel leveret mere
  end 60 min efter bekræftelse.
- Omfordelingsforslag bliver aldrig godkendt i simuleringen (ingen medarbejder), og
  samtaler, der overdrages til en medarbejder, forbliver uafklarede.

## 2. Årsagsanalyse (før-kørslen, 300 ordrer, gennemsnit af 4 seeds)

| Spørgsmål | Fund |
|---|---|
| Flyttes eksisterende løfter for ofte? | **Ja – hovedårsagen.** Den økonomiske strategi indsatte 100 nye ordrer pr. dag foran eksisterende stop (korteste omvej 123, først-til-mølle 0); *alle* rykkede andre stop. Det gav 46 ETA-ændringer til kunder mod 28 og 270 forsinkelsesminutter mod 201. Løftetolerancen (5 min) blev brugt som et budget i stedet for en buffer: hvert stop kunne skubbes helt op til løftet + 5 min, så der ikke var margin tilbage til kørselsvariation. |
| Får store ordrer for høj prioritet? | **Delvist.** Ventetid vægtes med ordreværdi (op til 2× for 300 kr. DB). Store ordrer var sjældent forsinkede (4,4 %), mens øvrige ordrer blev forsinket 14,0 % (først-til-mølle: 4,8 % mod 8,0 %). Små ordrer betalte for de stores forspring. |
| Placeres lageropfyldninger uhensigtsmæssigt? | **Antallet er problemet, ikke placeringen.** 64 opfyldninger pr. dag, og 100 % skyldtes varer, bilerne slet ikke har med (bilerne har 8 af 15 varer). Hvert besøg hentede kun præcis de manglende varer, så næste ordre med samme vare udløste et nyt besøg. Chaufførerne ventede samlet ca. 170 min pr. dag på opfyldninger (godkendelse tager i gns. 4,6 min). Startlageret er en antagelse; en fuld varepalet i bilerne (eksperiment) fjerner opfyldningerne helt. |
| Får chauffører for mange ruteændringer? | **Ikke via separate ruteændringstilbud** (0 pr. dag), men hver indsættelse foran andre stop *er* en ruteændring for chaufføren: ca. 100 pr. dag med den økonomiske strategi. |
| Bruges for meget tid på godkendelser? | Godkendelser tager i gns. ca. 5 min, men chaufføren står stille imens, hvis stoppet med varer fra lageret er først i ruten. |
| Skaber de økonomiske vægte uønsket adfærd? | **Ja.** Ventetid for den nye ordre og forsinkelse af lovede kunder vægtes ens, så det næsten altid "betaler sig" at sætte en ny ordre foran. Køretid (4 kr./min) dominerer ventetid (0,60 kr./min), så strategien minimerer køretid på bekostning af løfter. |
| Favoriserer simuleringen bestemte strategier? | Se afsnit 1: bot-fejlen ramte alle, men gjorde ETA'er for senere stop meget upræcise. Målet "forsinket i forhold til første løfte" belønner strategier, der giver færre og længere løfter (først-til-mølle). |

### Ledelsesindgreb

De 158 indgreb i v0.4.0-rapporten (300 ordrer, økonomisk strategi). I den rettede
før-kørsel var der i gennemsnit 142:

| Årsag | Antal | Vurdering |
|---|---:|---|
| Ledelsens beslutning om opfyldning | 48 | Nødvendige godkendelser (lagerproblemer) |
| Samme opfyldning talt igen (advarsel om lagerunderskud + udløbsadvarsel) | 74 | **Unødvendige/gentagne eskaleringer** |
| Valgfrie omfordelingsforslag talt som godkendelse | 13 | Skyldes ruteplanlægningen; ingen beslutning påkrævet |
| Chauffør svarer ikke | 4,8 | Manglende chaufførsvar (nødvendige) |
| Kapacitet / integrationsfejl | 2 | Nødvendige |

Godkendelsesreglerne er uændrede: opfyldninger kræver stadig ledelsens godkendelse,
og omfordelinger kræver stadig chaufførens accept.

## 3. Ændringer (v0.4.1)

**D. Adaptiv hybridstrategi** (`economics.strategy = 'adaptive'`, nu standard):

- **Belastning måles i kapacitet:** timers planlagt arbejde pr. aktiv chauffør
  (resterende rute til sidste stops ETA + 12 min pr. ventende ordre). Niveauer:
  lav, mellem og høj med **hysterese** (op ved 0,6/1,1, ned ved 0,85/0,4) og mindst
  10 min mellem skift. Et spring over to niveauer sker med det samme.
- **Løftebeskyttelse:**
  - Ved lav belastning må et lovet stop ikke rykkes.
  - Ved mellem belastning højst 3 min, og ved høj højst 8 min, og kun hvis der stadig er mindst 3 min margin til løftet.
  - Findes der ingen sådan placering hos nogen chauffør, bruges den mindst skadelige gyldige placering (de almindelige regler), og det skrives i begrundelsen. Ordren afvises aldrig.
- **Valg pr. niveau:**
  - Lav belastning: hurtigst levering til kunden (som først-til-mølle, uden store omveje).
  - Mellem belastning: mindst køretid og ventetid med stærk straf for at rykke løfter.
  - Høj belastning: kapacitet først (køretid) med højst 1,25× vægt på ordreværdi.
- **Lager og belastning:** chauffører, der kan tage varerne fra bilen eller kombinere med et allerede planlagt lagerbesøg, foretrækkes. Ved mellem og høj belastning foretrækkes chauffører med kortere resterende rute.
- **Ventende ordrer** behandles efter ventetid. Værdi har kun let indflydelse og kun ved høj belastning.

**Fælles regler (gælder alle strategier):**

- **Påfyldning ved lagerbesøg:** hent også varer til den forventede efterspørgsel de
  næste 90 min (salg de seneste 2 timer pr. aktiv chauffør, højst 40 enheder). Påfyldningen
  vises i godkendelsesbeskeden og godkendes sammen med opfyldningen.
- **Overvågning tæller samme beslutning én gang:**
  - Lagerunderskud med et opfyldningsforslag, der afventer godkendelse, er kategori A.
  - Der kommer ingen udløbsadvarsel efter opfyldningsmodulets egen eskalering.
  - Valgfrie omfordelingsforslag er kategori A.

  Den gamle adfærd kan genskabes med `monitoring.dedupeLinkedDecisions = false`.

## 4. Resultater

Se [comparison.md](comparison.md) for alle tal med spredning og dårligste resultat.
Hovedtal (gennemsnit af 4 seeds):

| Belastning | Nøgletal | Før (C, v0.4.0) | Efter (D, v0.4.1) |
|---|---|---:|---:|
| 150/8 | Forsinkede | 8,8 % | 5,1 % |
| | Forsinkelsesminutter | 116 | 60 |
| | P90 forsinkelse | 7,9 min | 1,4 min |
| | Gns. leveringstid | 38,5 min | 26,7 min |
| 300/8 | Leverede | 252 | 262 |
| | Manuelle sager | 10,5 | 2,5 |
| | Forsinkede | 11,6 % | 11,4 % |
| | Forsinkelsesminutter | 270 | 202 |
| | Gns. leveringstid | 63 min | 47 min |
| | Ledelsesindgreb | 68 | 33 |
| | Opfyldninger | 64 | 41 |
| 1.000/16 | Leverede | 701 | 745 |
| | Manuelle sager | 164 | 122 |
| | Forsinkelsesminutter | 810 | 678 |
| | Gns. leveringstid | 78 min | 64 min |

**Hvor den adaptive strategi ikke er bedst** (blandt de fire med v0.4.1-regler):

- **100 ordrer:** først-til-mølle leverer 0,5 ordre mere og har lidt højere omsætning og dækningsbidrag. Korteste omvej har mindst køretid, færrest opfyldninger og færrest ledelsesindgreb. Forskellene er inden for spredningen; den adaptive strategi har dog færrest forsinkelsesminutter og kortest leveringstid.
- **300–1.000 ordrer:** først-til-mølle har færre forsinkede i procent (9,3 % mod 11,4 % ved 300). Ved 500–1.000 har den også færre forsinkelsesminutter og lavere P90 – men leverer 24–68 færre ordrer, eskalerer 22–65 flere til manuel behandling og har flere leveringer over 60 min. Den lave procent skyldes delvist færre løfter (afsnit 1).
- **Køretid:** den adaptive strategi kører mere end den økonomiske strategi og korteste omvej ved alle belastninger (fx 2.515 mod 2.299 min ved 300), fordi den prioriterer løfter og hurtig levering over korteste rute.
- **De nye fælles regler** (påfyldning) gav færre opfyldninger og ledelsesindgreb for alle strategier, men en lidt højere forsinkelsesandel for de gamle strategier (fx først-til-mølle 7,2 % → 9,3 % ved 300), fordi flere ordrer nu leveres i stedet for at blive eskaleret.

## 5. Resterende svagheder

- Parametrene (grænser, buffer, vægte) er valgt ud fra modellens logik og ikke finjusteret
  på seeds. To varianter af løftebeskyttelsen gav identiske resultater, fordi beskyttelsen
  sjældent er den begrænsende faktor, når løfter ikke udhules.
- Ved meget høj belastning (1.000/16) eskaleres stadig ca. 12 % af de accepterede ordrer til
  manuel behandling, fordi ingen chauffør kan levere inden for maks. 120 min. Et
  "senere leveringstidspunkt med kundens accept" er ikke implementeret.
- Påfyldningen er en simpel efterspørgselsprognose (seneste 2 timer); den kender ikke
  bilernes faktiske varepalet eller lagerplads.
- Simuleringen har ingen medarbejder, ingen ruteoptimering via omfordelingsforslag og et
  antaget vognlager, en antaget efterspørgselsprofil og antaget adfærd.
