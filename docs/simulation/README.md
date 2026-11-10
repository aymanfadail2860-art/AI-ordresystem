# Driftssimulering – resultater

> ⚠️ **Forældet (v0.4.0).** Disse resultater blev lavet med en fejl i simuleringens
> chauffør-bot (genbesøg af leverede ordrer, ca. 4–5 min pr. stop), som gjorde dagene
> kunstigt overbelastede og ETA'erne for optimistiske. Se **[v0.4.1/README.md](v0.4.1/README.md)**
> for den rettede simulering, årsagsanalysen og den nye adaptive strategi.

> **SIMULEREDE DATA.** Alle tal stammer fra Demo Mode: simulerede kunder (SMS),
> chauffører (Telegram), ledere, kort og et virtuelt ur – kørt gennem hele AI
> Dispatch (agenter, regler, jobkø, database). Resultaterne beviser **ikke**
> ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer,
> rigtige køretider eller rigtige menneskers adfærd.

Genskab med fx `npm run simulate -- --orders 300 --drivers 8 --seed 42`.

| Fil | Scenarie |
|---|---|
| [comparison-seed42.md](comparison-seed42.md) | 300 henvendelser, 8 chauffører (2 på deltid), seed 42 |
| [comparison-seed7.md](comparison-seed7.md) | 300 henvendelser, 8 chauffører, seed 7 |
| [light/comparison-seed42.md](light/comparison-seed42.md) | 150 henvendelser, 8 chauffører, seed 42 (let belastning) |

Fælles for alle: kl. 10–22 (Europe/Copenhagen), leveringsområde ca. ±3,5 km,
Telegram-udfald 12 min, Google Maps-udfald 20 min, én chauffør uden svar i 35 min,
4 % ubesvarede tilbud, 3 % afslag, 6 % ændringer, 4 % annulleringer efter bekræftelse.
Alle tre strategier accepterede præcis de samme ordrer (276 / 266 / 137).

## Konklusion

**Høj belastning (300 henvendelser):** AI Dispatchs økonomiske strategi leverede
flest ordrer (234 og 232 mod 219–230), gav højest omsætning og dækningsbidrag
(+300–960 kr. pr. dag mod alternativerne) og den korteste gennemsnitlige
leveringstid (84 mod 92–97 min) med færrest uafklarede ordrer.

Den var **ikke** bedst på:
- **Andel forsinkede leverancer** i forhold til første lovede tidspunkt (29,5 % og
  33,6 % mod 22–25 % for først-til-mølle). Den økonomiske model rykker eksisterende
  stop inden for tolerancen for at få plads til nye ordrer – det giver flere små
  overskridelser af det først kommunikerede tidspunkt.
- **90 %-fraktilen** for leveringstid, **lagerproblemer** og **ledelsesindgreb**
  (først-til-mølle var bedst) samt (seed 42) **køretid pr. levering** (korteste
  omvej var bedst).

**Let belastning (150 henvendelser):** først-til-mølle var bedst på næsten alt –
kortere leveringstid (30,5 mod 40 min), færre forsinkede (14 % mod 19,5 %) og
marginalt højere dækningsbidrag. Med ledig kapacitet giver den økonomiske
omrokering ingen gevinst, kun ekstra forsinkelse af allerede planlagte stop.

**Anbefaling før pilotdrift:** kalibrér den økonomiske model (fx højere
vægt/forsinkelsesstraf for at rykke allerede lovede stop, eller lavere tolerance)
og overvej at bruge først-til-mølle-lignende adfærd, når der er ledig kapacitet.
Gentag simuleringen med anonymiserede historiske ordredata.

## Måledefinitioner

- *Forsinket*: leveret senere end det først kommunikerede ETA + tolerance (5 min).
- *Leveringstid*: fra kundens bekræftelse til bekræftet levering.
- *Køretid*: simuleret kørsel (inkl. trafikvariation og hændelser); *køretid til lager*: opfyldning og afhentning på centrallager.
- *Lagerproblemer*: opfyldningsforslag + "ikke nok på lager"-svar + eskaleringer.
- *Ledelsesindgreb*: ledelsens godkendelser/afvisninger + advarsler i kategori C og D.
- *Fejlede/uafklarede handlinger*: døde jobs + usikre/fejlede beskeder + bekræftede ordrer der ikke blev leveret eller annulleret.
- Samtaler, der overdrages til medarbejder (fx under kortudfald), forbliver uafklarede – simuleringen har ingen medarbejder.
