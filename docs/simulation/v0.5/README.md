# Etape 5 – alternative leveringstider, fysisk lagerkapacitet og kvalitetssikring

> **SIMULEREDE DATA.** Tallene kommer fra driftssimuleringen i Demo Mode (simulerede
> kunder, chauffører, ledere, kort og Telegram, virtuelt ur). De beviser ikke ydeevne
> mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.

| Fil | Indhold |
|---|---|
| [comparison.md](comparison.md) | Alle tal pr. belastning: gennemsnit ± spredning (dårligste) og manuelle sager pr. årsag |
| `before.json` | Hybridstrategi v0.4.1 (ingen kapacitet, ingen alternative tider) |
| `capacity-only.json` | v0.5 med fysisk kapacitet, uden alternative tider |
| `after.json` | v0.5 med standardindstillinger |
| `after-with-queue.json` | v0.5 med intern kø slået til |

Matrix: 150/8, 300/8, 500/10 og 1.000/16 (henvendelser/chauffører) × 4 seeds med hver
sin profil × hybridstrategien. Genskab med:

```bash
npm run simulate:matrix -- --loads 150,300,500,1000 --strategies adaptive --v041 --out docs/simulation/v0.5/before.json
```

```bash
npm run simulate:matrix -- --loads 150,300,500,1000 --strategies adaptive --no-alternatives --out docs/simulation/v0.5/capacity-only.json
```

```bash
npm run simulate:matrix -- --loads 150,300,500,1000 --strategies adaptive --out docs/simulation/v0.5/after.json
```

```bash
node scripts/sim-report-v05.mjs
```

## 1. Analyse af de manuelle sager ved 1.000 ordrer (v0.4.1)

Én simuleret dag (seed 11, standardprofil) gav 88 manuelle sager. Alle havde samme
årsag: **"Ingen forsvarlig chaufførtildeling inden for 20 minutter"**.

| Spørgsmål | Fund |
|---|---|
| Hvorfor fandtes der ingen chauffør? | Næsten alle afvisninger var "Ingen ledig kapacitet": alle chauffører havde nået loftet på 6 aktive ordrer. Der var 4.951 afvisninger med den årsag; "Offline" og "ubesvaret tilbud" var sjældne. |
| Hvornår? | Aftenspidsen kl. 18–22 lokal tid (16–20 UTC), og især kl. 19–20. |
| Hvor længe? | Alle blev eskaleret præcis ved 20-minutters-grænsen. |
| Usikre data eller reelle konflikter? | Ingen usikre data. Det er reel mangel på kapacitet, som varer til lukketid (kl. 22). |

**Konsekvens for løsningen:** et senere tidspunkt kan kun hjælpe, hvis der findes kapacitet
senere *samme dag*. Uden viden om chaufførernes vagter må et foreslået tidsrum som
standard ikke slutte efter lukketid (`latestAfterCloseMinutes = 0`). Ved 1.000 ordrer
varer spidsen netop til lukketid, så her er der sjældent noget forsvarligt tidspunkt at tilbyde.

## 2. Det implementerede

**Alternative leveringstider (`agents/timeOffers.ts`):**

- **Hvornår der tilbydes et tidspunkt:** hvis ingen chauffør kan levere inden for den normale ramme af kapacitets- eller tidsgrunde, og ordren har ventet 8 min.
- **Beregning:** systemet finder det tidligste realistiske tidsrum. Det er efter den chaufførs sidste stop og efter andre kunders reserverede pladser, plus 5 min margin, afrundet til et kvarter, med en længde på 15 min.
- **SMS:** "Vi har ekstra travlt lige nu. Vi kan levere din bestilling (ordre #X) omkring kl. 21.15–21.30. Passer det dig? Svar JA, skriv et andet klokkeslæt (fx "kl. 22") eller svar NEJ."
- **Reservation:** forslaget reserverer en plads i chaufførens kø, så den samme kapacitet ikke loves to gange. Det udløber efter 10 min.
- **Kundens svar fortolkes deterministisk** (`core/timeReply.ts`). AI'en bruges kun som støtte til ja/nej.

| Kundens svar | Hvad systemet gør |
|---|---|
| "Ja" / "Det er fint" | Tidspunktet valideres igen (kun reservationer før kundens egen tæller). Holder det, noteres det: "Vi har noteret levering …". Ellers sendes et nyt forslag. |
| "Kan I komme kl. 22?" | Kan tidspunktet nås, noteres det. Ellers: "Kl. 22 kan vi desværre ikke nå. Det tidligste mulige er nu: …" |
| "Hvad er det tidligste?" | Et nyt, opdateret forslag. |
| "Nej, det er for sent" | En medarbejder overtager; samtalen sættes på pause. |
| Intet svar inden 10 min | En medarbejder overtager. |
| Uklart svar | Systemet spørger én gang mere og overdrager derefter. |

- **Efter accept:**
  - Tidsrummet gemmes på ordren, og kundens løfte er slutningen af tidsrummet.
  - Chaufføren tildeles 45 min før tidsrummet.
  - Ved "tidligst muligt" må chaufføren komme højst 30 min før; ved et ønsket klokkeslæt højst 10 min før.
  - Kan tidsrummet ikke længere nås 20 min før, får kunden et nyt forslag. Efter 3 forslag overtager en medarbejder.
- **Kundeløftet:** der skrives aldrig, at leveringen er bekræftet, før en chauffør har accepteret.
- **Ingen ordre afvises på grund af værdi.**
- **Intern kø uden kundekontakt** (`queueWithinNormalTime`): er **slået fra** som standard, fordi den ikke gav en målbar gevinst (se afsnit 3).

**Fysisk lagerkapacitet (`InventoryService`):**

- Hver vare har en plads i lagerenheder (`unit_volume`, standard 1).
- Hver bil kan have:
  - en samlet kapacitet,
  - en kapacitet pr. varetype (fx fryseboks),
  - et fast sortiment med normalbeholdning og maks.,
  - "flex"-plads til varer uden for sortimentet.
- Status pr. bil: fysisk lager, reserveret, fri plads og planlagte afhentninger.
- **Håndhævelse:**
  - Overførsler til bilen afvises, hvis varerne ikke kan være der.
  - En afhentning springer de ordrer over, der ikke kan være i bilen; de hentes ved næste besøg.
  - Dispatch tildeler ikke en ordre med varer fra lageret til en bil, der ikke kan rumme dem.
  - Kan ingen bil rumme ordren, går den straks til en medarbejder.

**Opfyldning inden for bilens plads (`ReplenishmentService`):**

- Kun de ordrer, der kan være i bilen, dækkes. Plads, der frigøres af leveringer før lagerbesøget, regnes med.
- Påfyldningen prioriteres i denne rækkefølge:
  1. varer til de accepterede leveringer, opfyldningen dækker,
  2. aftalte senere leveringer hos chaufføren,
  3. forventet efterspørgsel, valgt efter dækningsbidrag pr. lagerenhed.
- Godkendelsesbeskeden viser bilens plads og hvad der er fravalgt pga. plads.
- Ledelsens godkendelse er uændret.

## 3. Resultater (gennemsnit af 4 seeds – se comparison.md)

| Belastning | Nøgletal | Før v0.4.1 | Kun kapacitet | **Efter v0.5** |
|---|---|---:|---:|---:|
| 150/8 | Leveret / manuelle | 132,5 / 0 | 131,5 / 1 | 131,5 / 1 |
| | Forsinkelsesminutter | 60 | 86 | 86 |
| 300/8 | Leveret / manuelle | 261,5 / 2,5 | 258,8 / 4,8 | 258,8 / 4,8 |
| | Forsinkelsesminutter | 202 | 234 | 238 |
| 500/10 | Leveret / manuelle | 403,3 / 32,5 | 396,5 / 39 | 398,5 / 37,3 |
| | Senere tidspunkter tilbudt / accepteret | – | – | 2,8 / 1 |
| | Forsinkelsesminutter | 468 | 575 | 553 |
| 1.000/16 | Leveret / manuelle | 744,8 / 121,8 | 720,8 / 144,8 | 710 / 156,8 |
| | Senere tidspunkter tilbudt / accepteret | – | – | 22,5 / 12,3 |
| | Aftalte tidsrum overholdt | – | – | 8,3 af 12,3 (67 %) |
| | Forsinkelsesminutter | 678 | 736 | 976 |
| | Gns. leveringstid | 64 min | 71 min | 74 min |

**Åbent om de negative effekter:**

1. **Den fysiske kapacitet koster.** Med realistisk plads (240 lagerenheder, fryseboks 12,
   husholdning 24) leveres færre ordrer end i v0.4.1, hvor alle varer fyldte ens og bilerne
   aldrig var fulde: −24 ved 1.000 ordrer, og flere manuelle sager. Det er ikke en fejl i
   strategien, men en mere ærlig model. Der er også ordrer, der fysisk ikke kan være i én bil
   (fx 3–6 pakker toiletpapir), og de går nu straks til en medarbejder.
2. **Alternative leveringstider løser ikke de manuelle sager ved 1.000 ordrer** – de gør det
   lidt værre:
   - 11 færre leverede, 12 flere manuelle sager og flere forsinkelsesminutter end uden alternativer.
   - Kapaciteten er opbrugt til lukketid, så kun få kunder kan få et tidspunkt.
   - De faste, accepterede tidsrum og deres reservationer gør ruterne mindre effektive.
   - Kun 67 % af de aftalte tidsrum blev overholdt.
3. **Ved 500 ordrer** hjælper de lidt: 2 flere leverede, 1,7 færre manuelle sager og færre forsinkelsesminutter. Ved 150–300 ordrer gør de næsten ingen forskel.
4. **Den interne kø** (køplads uden kundekontakt) gav ingen målbar gevinst: ved 1.000 ordrer 155 mod 157 manuelle sager, men længere leveringstid. Den er derfor slået fra som standard.

**Manuelle sager, der blev løst:**

| | Antal pr. dag ved 1.000 ordrer |
|---|---:|
| Accepterede senere tidspunkter (brutto) | 12,3 |
| Heraf leveret inden for det aftalte tidsrum | 8,3 |
| Nettoændring i manuelle sager mod kun kapacitet | +12 (ingen sager reelt løst) |

Ved 500 ordrer er nettoændringen −1,7.

**Anbefaling:** brug alternative leveringstider, når chaufførerne reelt kan arbejde efter lukketid
(`latestAfterCloseMinutes` > 0 og vagtplan). Det samme gælder, når spidsbelastningen er midlertidig.
Kalibrér kapaciteter og sortiment på rigtige biler, før funktionen bruges i drift.

## 4. Kvalitetssikring af ordreflowet

Flowet kunde → SMS → AI → ordre → reservation → dispatch → chauffør → levering →
kundeopdatering → rapportering er gennemgået. Fundne og rettede fejl:

| Fejl | Konsekvens | Rettelse |
|---|---|---|
| Ved en ny tildeling (fx omfordeling) blev kundens lovede tidspunkt overskrevet i stilhed (SMS'en blev ikke sendt igen pga. idempotens) | Systemet troede, kunden havde fået den nye tid. Forsinkelser i forhold til det reelle løfte blev skjult for overvågning og kundeopdateringer | Løftet ændres kun via de almindelige ETA-opdateringer, som kunden får besked om |
| Overdragelse fra et tidsforslag under manuel overtagelse | Ville sende en automatisk SMS midt i medarbejderens samtale og ændre den fra "manuel" til "AI pauseret" | Ingen SMS og ingen tilstandsændring, når samtalen er manuel |
| Overvågningen talte ordrer med aftalt senere tidsrum eller afventende kundesvar som "manglende kapacitet" | Falske D-advarsler (menneskelig overtagelse) | Planlagte ordrer udelades; ordrer i kø er kun orientering |
| Interne køpladser blev talt med i chaufførens loft | Køede ordrer blokerede hinanden, indtil pladserne udløb (fundet i simuleringen, før udgivelse) | Kun tidsrum aftalt med kunden reserverer kapacitet |
| Genvalidering talte andre kunders senere reservationer med | Accepterede tidsrum blev fejlagtigt afvist (fundet i simuleringen, før udgivelse) | Kun reservationer før kundens eget tidsrum tæller |
| Overdragelsesbesked blev blokeret, når samtalen samtidig blev sat på pause (fundet i test) | Kunden fik ikke at vide, at en medarbejder overtager | Beskeden sendes som overdragelse (samme regel som øvrige overdragelser) |

Øvrige områder (idempotens af SMS/Telegram, genstart, udløbne tilbud, usikker afsendelse,
ugyldige AI-svar, integrationsfejl) er dækket af eksisterende tests og blev ikke ændret.

## 5. Begrænsninger

- Simuleringens kunder accepterer et senere tidspunkt med en fast sandsynlighed (ca. 63 % ved første forslag). Rigtige kunder kan opføre sig anderledes.
- Bilernes kapacitet, varernes plads og sortimentet er antagelser.
- Chaufførernes vagter er ikke modelleret. Uden vagtplan foreslås ingen tidsrum efter lukketid.
- Påfyldningens efterspørgselsprognose bygger på de seneste 2 timers salg.
