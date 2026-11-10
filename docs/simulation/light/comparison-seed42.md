# Driftssimulering – sammenligning af dispatchstrategier

> **SIMULEREDE DATA.** Resultatet stammer fra Demo Mode med simulerede kunder, chauffører, kort og Telegram. Det beviser ikke ydeevne mod rigtige Apple Messages-, Telegram- eller Google Maps-integrationer.

Seed 42 · 150 kundehenvendelser · 8 chauffører · 2026-06-16 kl. 10–22 (Europe/Copenhagen) · midlertidige fejl: Telegram-udfald 12 min, Google Maps-udfald 20 min, én chauffør uden svar i 35 min.

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | Bedst |
|---|---:|---:|---:|---|
| Leverede ordrer (højere er bedst) | **134** | 133 | 133 | A |
| Omsætning (højere er bedst) | **14.831 kr.** | 14.768 kr. | 14.732 kr. | A |
| Dækningsbidrag (højere er bedst) | **10.595 kr.** | 10.538 kr. | 10.519 kr. | A |
| Leveringer pr. chaufførtime (højere er bedst) | **1,6** | **1,6** | **1,6** | A, B, C |
| Gns. leveringstid (min) (lavere er bedst) | **30,5** | 55,8 | 40,1 | A |
| 90 %-fraktil leveringstid (min) (lavere er bedst) | **55,5** | 116,5 | 91 | A |
| Andel forsinkede (%) (lavere er bedst) | **14,2** | 27,8 | 19,5 | A |
| Køretid pr. levering (min) (lavere er bedst) | 12,6 | **8,8** | 9,4 | B |
| Køretid til lager (min) (lavere er bedst) | 328 | **177** | 199 | B |
| Lagerproblemer (lavere er bedst) | 102 | **72** | 85 | B |
| Ledelsesindgreb (lavere er bedst) | 118 | 110 | **94** | C |
| Fejlede/uafklarede handlinger (lavere er bedst) | **0** | **0** | 1 | A, B |

## Øvrige tal

| Felt | A. Først-til-mølle | B. Korteste ekstra køretid | C. AI Dispatch (økonomisk) | |
|---|---:|---:|---:|---|
| ordersGenerated | 150 | 150 | 150 | |
| ordersAccepted | 137 | 137 | 137 | |
| cancelled | 3 | 4 | 3 | |
| unresolved | 0 | 0 | 1 | |
| lateCount | 19 | 37 | 26 | |
| driveMinutes | 1.683 | 1.165 | 1.249 | |
| extraDriveMinutes | 1.707 | 1.137 | 1.180 | |
| replenishments | 49 | 36 | 40 | |
| replenishmentsCompleted | 36 | 23 | 24 | |
| offersRejectedOrExpired | 13 | 26 | 23 | |
| conversationsNeedingStaff | 5 | 4 | 5 | |
| integrationFailures | 2 | 2 | 2 | |
| hourlyReportsSent | 12 | 12 | 12 | |
| alertsRaised | 175 | 189 | 161 | |
| driverHours | 83,7 | 85,6 | 83 | |
| deliveriesPerHour | 11,2 | 11,1 | 11,1 | |

## Vurdering

- AI Dispatch mod A. Først-til-mølle: dækningsbidrag -76 kr., leverede 133 mod 134, forsinkede 19,5 % mod 14,2 %, gns. leveringstid 40,1 mod 30,5 min.
- AI Dispatch mod B. Korteste ekstra køretid: dækningsbidrag -19 kr., leverede 133 mod 133, forsinkede 19,5 % mod 27,8 %, gns. leveringstid 40,1 mod 55,8 min.
- AI Dispatch er IKKE bedst på: Leverede ordrer, Omsætning, Dækningsbidrag, Gns. leveringstid (min), 90 %-fraktil leveringstid (min), Andel forsinkede (%), Køretid pr. levering (min), Køretid til lager (min), Lagerproblemer, Fejlede/uafklarede handlinger.
