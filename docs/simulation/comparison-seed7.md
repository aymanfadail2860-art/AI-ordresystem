# Driftssimulering – sammenligning af dispatchstrategier

> **SIMULEREDE DATA.** Resultatet stammer fra Demo Mode med simulerede kunder, chauffører, kort og Telegram. Det beviser ikke ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.

Seed 7 · 300 kundehenvendelser · 8 chauffører · 2026-06-16 kl. 10–22 (Europe/Copenhagen) · midlertidige fejl: Telegram-udfald 12 min, Google Maps-udfald 20 min, én chauffør uden svar i 35 min.

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | Bedst |
|---|---:|---:|---:|---|
| Leverede ordrer (højere er bedst) | 219 | 230 | **232** | C |
| Omsætning (højere er bedst) | 24.463 kr. | 25.325 kr. | **25.858 kr.** | C |
| Dækningsbidrag (højere er bedst) | 17.409 kr. | 18.046 kr. | **18.344 kr.** | C |
| Leveringer pr. chaufførtime (højere er bedst) | 2,4 | 2,4 | **2,5** | C |
| Gns. leveringstid (min) (lavere er bedst) | 93 | 92,2 | **83,6** | C |
| 90 %-fraktil leveringstid (min) (lavere er bedst) | **153** | 170,5 | 168 | A |
| Andel forsinkede (%) (lavere er bedst) | **24,7** | 40,9 | 33,6 | A |
| Køretid pr. levering (min) (lavere er bedst) | 11,9 | **9,7** | **9,7** | B, C |
| Køretid til lager (min) (lavere er bedst) | 282 | 286 | **277** | C |
| Lagerproblemer (lavere er bedst) | **65** | 82 | 87 | A |
| Ledelsesindgreb (lavere er bedst) | **131** | 168 | 148 | A |
| Fejlede/uafklarede handlinger (lavere er bedst) | 120 | 97 | **84** | C |

## Øvrige tal

| Felt | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | |
|---|---:|---:|---:|---|
| ordersGenerated | 300 | 300 | 300 | |
| ordersAccepted | 266 | 266 | 266 | |
| cancelled | 10 | 8 | 9 | |
| unresolved | 37 | 28 | 25 | |
| lateCount | 54 | 94 | 78 | |
| driveMinutes | 2.605 | 2.221 | 2.255 | |
| extraDriveMinutes | 2.695 | 2.188 | 2.237 | |
| replenishments | 40 | 47 | 47 | |
| replenishmentsCompleted | 30 | 32 | 31 | |
| offersRejectedOrExpired | 63 | 51 | 62 | |
| conversationsNeedingStaff | 9 | 11 | 10 | |
| integrationFailures | 2 | 2 | 2 | |
| hourlyReportsSent | 12 | 12 | 12 | |
| alertsRaised | 285 | 397 | 367 | |
| driverHours | 92,5 | 94,3 | 93,6 | |
| deliveriesPerHour | 18,3 | 19,2 | 19,3 | |

## Vurdering

- AI Dispatch mod A. Først-til-mølle: dækningsbidrag +935 kr., leverede 232 mod 219, forsinkede 33,6 % mod 24,7 %, gns. leveringstid 83,6 mod 93 min.
- AI Dispatch mod B. Korteste ekstra køretid: dækningsbidrag +298 kr., leverede 232 mod 230, forsinkede 33,6 % mod 40,9 %, gns. leveringstid 83,6 mod 92,2 min.
- AI Dispatch er IKKE bedst på: 90 %-fraktil leveringstid (min), Andel forsinkede (%), Lagerproblemer, Ledelsesindgreb.
