# Driftssimulering – sammenligning af dispatchstrategier

> **SIMULEREDE DATA.** Resultatet stammer fra Demo Mode med simulerede kunder, chauffører, kort og Telegram. Det beviser ikke ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.

Seed 42 · 300 kundehenvendelser · 8 chauffører · 2026-06-16 kl. 10–22 (Europe/Copenhagen) · midlertidige fejl: Telegram-udfald 12 min, Google Maps-udfald 20 min, én chauffør uden svar i 35 min.

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | Bedst |
|---|---:|---:|---:|---|
| Leverede ordrer (højere er bedst) | 223 | 230 | **234** | C |
| Omsætning (højere er bedst) | 24.112 kr. | 24.785 kr. | **25.475 kr.** | C |
| Dækningsbidrag (højere er bedst) | 17.251 kr. | 17.808 kr. | **18.214 kr.** | C |
| Leveringer pr. chaufførtime (højere er bedst) | 2,3 | **2,4** | **2,4** | B, C |
| Gns. leveringstid (min) (lavere er bedst) | 97,1 | 93,4 | **84,7** | C |
| 90 %-fraktil leveringstid (min) (lavere er bedst) | **151** | 181,5 | 156,5 | A |
| Andel forsinkede (%) (lavere er bedst) | **22,4** | 23,9 | 29,5 | A |
| Køretid pr. levering (min) (lavere er bedst) | 12,3 | **10** | 10,1 | B |
| Køretid til lager (min) (lavere er bedst) | 380 | 334 | **332** | C |
| Lagerproblemer (lavere er bedst) | **76** | 104 | 108 | A |
| Ledelsesindgreb (lavere er bedst) | **145** | 151 | 158 | A |
| Fejlede/uafklarede handlinger (lavere er bedst) | 131 | 109 | **100** | C |

## Øvrige tal

| Felt | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | |
|---|---:|---:|---:|---|
| ordersGenerated | 300 | 300 | 300 | |
| ordersAccepted | 276 | 276 | 276 | |
| cancelled | 9 | 10 | 11 | |
| unresolved | 44 | 36 | 31 | |
| lateCount | 50 | 55 | 69 | |
| driveMinutes | 2.734 | 2.290 | 2.361 | |
| extraDriveMinutes | 2.813 | 2.245 | 2.328 | |
| replenishments | 50 | 59 | 58 | |
| replenishmentsCompleted | 39 | 36 | 39 | |
| offersRejectedOrExpired | 92 | 63 | 72 | |
| conversationsNeedingStaff | 9 | 8 | 7 | |
| integrationFailures | 2 | 2 | 2 | |
| hourlyReportsSent | 12 | 12 | 12 | |
| alertsRaised | 273 | 305 | 366 | |
| driverHours | 95,9 | 93,9 | 97,4 | |
| deliveriesPerHour | 18,6 | 19,2 | 19,5 | |

## Vurdering

- AI Dispatch mod A. Først-til-mølle: dækningsbidrag +964 kr., leverede 234 mod 223, forsinkede 29,5 % mod 22,4 %, gns. leveringstid 84,7 mod 97,1 min.
- AI Dispatch mod B. Korteste ekstra køretid: dækningsbidrag +406 kr., leverede 234 mod 230, forsinkede 29,5 % mod 23,9 %, gns. leveringstid 84,7 mod 93,4 min.
- AI Dispatch er IKKE bedst på: 90 %-fraktil leveringstid (min), Andel forsinkede (%), Køretid pr. levering (min), Lagerproblemer, Ledelsesindgreb.
