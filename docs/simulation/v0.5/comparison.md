# Etape 5 – hybridstrategien før og efter

> **SIMULEREDE DATA.** Se [README.md](README.md) for forudsætninger, analyse og begrænsninger.

Celler: gennemsnit ± standardafvigelse (dårligste) over 4 seeds/profiler (standard, store ordrer, spredte adresser, flere centrallagervarer). Strategi: adaptiv hybrid i alle kolonner.

- **Før (v0.4.1):** ingen alternative tider; alle varer fylder ens, og bilerne har ubegrænset plads.
- **Kun kapacitet:** v0.5 med fysisk kapacitet (240 lagerenheder pr. bil, fryseboks 12, husholdning 24, fast sortiment), men uden alternative tider.
- **Efter (v0.5):** fysisk kapacitet + alternative leveringstider (standardindstillinger; intern kø slået fra).
- **v0.5 + intern kø:** som Efter, men med `alternatives.queueWithinNormalTime = true`.

## 150 henvendelser, 8 chauffører

| Nøgletal | Før (v0.4.1) | Kun kapacitet | Efter (v0.5) | v0.5 + intern kø |
|---|---:|---:|---:|---:|
| Accepterede ordrer | 134,8 ± 1,8 (133) | 134,8 ± 1,8 (133) | 134,8 ± 1,8 (133) | 134,8 ± 1,8 (133) |
| Leverede ordrer | 132,5 ± 2,1 (130) | 131,5 ± 2,1 (130) | 131,5 ± 2,1 (130) | 131,5 ± 2,1 (130) |
| Manuelle sager | 0 ± 0 (0) | 1 ± 1,7 (4) | 1 ± 1,7 (4) | 1 ± 1,7 (4) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Ordrer sat i intern kø | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0,5 ± 0,5 (1) |
| Ordrer tilbudt senere tidspunkt | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Senere tidspunkter accepteret | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Aftalte tidsrum overholdt | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Leverede med aftalt tidsrum | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Forsinkede (%) | 5,1 ± 1,1 (6,7) | 7,6 ± 3,1 (10,8) | 7,6 ± 3,1 (10,8) | 7,6 ± 3,1 (10,8) |
| Forsinkelsesminutter | 60 ± 23 (99) | 85,8 ± 31,2 (106) | 85,8 ± 31,2 (106) | 85,8 ± 31,2 (106) |
| P90 forsinkelse (min) | 1,4 ± 1,8 (4,3) | 6 ± 5,4 (11,8) | 6 ± 5,4 (11,8) | 6 ± 5,4 (11,8) |
| Gns. leveringstid (min) | 26,7 ± 3,9 (32,6) | 27,8 ± 4 (32,5) | 27,8 ± 4 (32,5) | 27,8 ± 4 (32,5) |
| Lageropfyldninger | 29,3 ± 6,4 (36) | 29,8 ± 8,4 (40) | 29,8 ± 8,4 (40) | 29,8 ± 8,4 (40) |
| Kapacitetsproblemer | 0 ± 0 (0) | 6,8 ± 6,8 (18) | 6,8 ± 6,8 (18) | 6,8 ± 6,8 (18) |
| Ledelsesindgreb | 31 ± 6,5 (39) | 30,8 ± 7 (39) | 30,8 ± 7 (39) | 30,8 ± 7 (39) |
| Fejlede/uafklarede | 0 ± 0 (0) | 3,3 ± 5,6 (13) | 3,3 ± 5,6 (13) | 3,3 ± 5,6 (13) |

**Manuelle sager pr. årsag (sum over seeds):**

- Før (v0.4.1): ingen
- Kun kapacitet: Ordren fylder mere, end der er plads til i bilerne (3); Ingen forsvarlig chaufførtildeling inden for 20 minutter (1)
- Efter (v0.5): Ordren fylder mere, end der er plads til i bilerne (3); Ingen forsvarlig chaufførtildeling inden for 20 minutter (1)
- v0.5 + intern kø: Ordren fylder mere, end der er plads til i bilerne (3); Ingen forsvarlig chaufførtildeling inden for 20 minutter (1)

## 300 henvendelser, 8 chauffører

| Nøgletal | Før (v0.4.1) | Kun kapacitet | Efter (v0.5) | v0.5 + intern kø |
|---|---:|---:|---:|---:|
| Accepterede ordrer | 272 ± 3,2 (268) | 272 ± 3,2 (268) | 272 ± 3,2 (268) | 272 ± 3,2 (268) |
| Leverede ordrer | 261,5 ± 5 (254) | 258,8 ± 7 (248) | 258,8 ± 7 (248) | 258,8 ± 7 (248) |
| Manuelle sager | 2,5 ± 2,7 (7) | 4,8 ± 5,1 (13) | 4,8 ± 5,1 (13) | 4,8 ± 5,1 (13) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) |
| Ordrer sat i intern kø | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 11,5 ± 17,6 (42) |
| Ordrer tilbudt senere tidspunkt | 0 ± 0 (0) | 0 ± 0 (0) | 1,3 ± 2,2 (5) | 0,5 ± 0,9 (2) |
| Senere tidspunkter accepteret | 0 ± 0 (0) | 0 ± 0 (0) | 0,5 ± 0,9 (2) | 0 ± 0 (0) |
| Aftalte tidsrum overholdt | 0 ± 0 (0) | 0 ± 0 (0) | 0,3 ± 0,4 (1) | 0 ± 0 (0) |
| Leverede med aftalt tidsrum | 0 ± 0 (0) | 0 ± 0 (0) | 0,5 ± 0,9 (2) | 0 ± 0 (0) |
| Forsinkede (%) | 11,4 ± 1,6 (13,8) | 10,9 ± 3,5 (16,1) | 11,1 ± 2,9 (15,7) | 10,1 ± 1,5 (11,8) |
| Forsinkelsesminutter | 202,3 ± 14,7 (216) | 233,5 ± 111,6 (414) | 237,5 ± 84,1 (378) | 206,8 ± 35,6 (255) |
| P90 forsinkelse (min) | 9,6 ± 0,5 (10,1) | 9,7 ± 3,2 (14,8) | 10,4 ± 2,3 (14,3) | 9,7 ± 1,1 (11,7) |
| Gns. leveringstid (min) | 46,5 ± 13 (67,9) | 48,2 ± 14,5 (72,1) | 48,3 ± 15,5 (74,1) | 48,3 ± 15,5 (74) |
| Lageropfyldninger | 41 ± 8,4 (52) | 42,5 ± 10,8 (60) | 42,5 ± 10,7 (60) | 42,3 ± 10,8 (60) |
| Kapacitetsproblemer | 0 ± 0 (0) | 24 ± 29,9 (75) | 23,5 ± 30 (75) | 22,8 ± 30,4 (75) |
| Ledelsesindgreb | 33 ± 4,6 (38) | 36,3 ± 8,7 (50) | 36,3 ± 8,7 (50) | 36 ± 8,7 (50) |
| Fejlede/uafklarede | 11,5 ± 18,2 (43) | 16,3 ± 24,2 (58) | 17,8 ± 26,2 (63) | 17,3 ± 25,3 (61) |

**Manuelle sager pr. årsag (sum over seeds):**

- Før (v0.4.1): Ingen forsvarlig chaufførtildeling inden for 20 minutter (10)
- Kun kapacitet: Ingen forsvarlig chaufførtildeling inden for 20 minutter (14); Ordren fylder mere, end der er plads til i bilerne (5)
- Efter (v0.5): Ingen realistisk leveringstid inden for åbningstiden (11); Ordren fylder mere, end der er plads til i bilerne (5); Ingen forsvarlig chaufførtildeling inden for 20 minutter (1); Kunden svarede ikke på forslag om senere levering (1); Kunden afviste foreslået leveringstid (1)
- v0.5 + intern kø: Ingen realistisk leveringstid inden for åbningstiden (14); Ordren fylder mere, end der er plads til i bilerne (5)

## 500 henvendelser, 10 chauffører

| Nøgletal | Før (v0.4.1) | Kun kapacitet | Efter (v0.5) | v0.5 + intern kø |
|---|---:|---:|---:|---:|
| Accepterede ordrer | 452,5 ± 3,9 (447) | 452,5 ± 3,9 (447) | 452,5 ± 3,9 (447) | 452,5 ± 3,9 (447) |
| Leverede ordrer | 403,3 ± 29,1 (354) | 396,5 ± 26,4 (357) | 398,5 ± 29,1 (351) | 396,8 ± 30,3 (349) |
| Manuelle sager | 32,5 ± 27,3 (77) | 39 ± 26 (74) | 37,3 ± 27,7 (80) | 38,8 ± 29 (82) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0,3 ± 0,4 (1) | 0 ± 0 (0) | 0,3 ± 0,4 (1) |
| Ordrer sat i intern kø | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 57,8 ± 13,3 (73) |
| Ordrer tilbudt senere tidspunkt | 0 ± 0 (0) | 0 ± 0 (0) | 2,8 ± 4,2 (10) | 4,8 ± 8,2 (19) |
| Senere tidspunkter accepteret | 0 ± 0 (0) | 0 ± 0 (0) | 1 ± 1,2 (3) | 1,5 ± 2,6 (6) |
| Aftalte tidsrum overholdt | 0 ± 0 (0) | 0 ± 0 (0) | 0,8 ± 1,3 (3) | 0,5 ± 0,9 (2) |
| Leverede med aftalt tidsrum | 0 ± 0 (0) | 0 ± 0 (0) | 1 ± 1,2 (3) | 1,5 ± 2,6 (6) |
| Forsinkede (%) | 13,5 ± 1,1 (15,3) | 14 ± 2,9 (19) | 14,4 ± 3 (19,1) | 14,4 ± 3,5 (20,3) |
| Forsinkelsesminutter | 468 ± 82,2 (591) | 574,5 ± 119,8 (659) | 553,3 ± 154,7 (704) | 600,8 ± 151,7 (761) |
| P90 forsinkelse (min) | 11,3 ± 1 (12,9) | 12,8 ± 2,5 (16,6) | 13,2 ± 2,7 (16,6) | 13,3 ± 2,8 (17,3) |
| Gns. leveringstid (min) | 63,2 ± 8,1 (76) | 67,4 ± 6,9 (74,5) | 66,4 ± 6,3 (74,3) | 68,3 ± 7,3 (76,2) |
| Lageropfyldninger | 65 ± 13,1 (86) | 71,3 ± 19 (97) | 69,5 ± 19,6 (95) | 70,3 ± 18,1 (93) |
| Kapacitetsproblemer | 0 ± 0 (0) | 48 ± 46 (126) | 48,5 ± 44,2 (122) | 50,3 ± 43,4 (122) |
| Ledelsesindgreb | 53 ± 5,6 (59) | 62,5 ± 14 (77) | 59,8 ± 13,8 (74) | 60,5 ± 13,2 (76) |
| Fejlede/uafklarede | 120,5 ± 63,4 (216) | 137 ± 66,3 (219) | 133,5 ± 58,9 (224) | 148,5 ± 72,2 (248) |

**Manuelle sager pr. årsag (sum over seeds):**

- Før (v0.4.1): Ingen forsvarlig chaufførtildeling inden for 20 minutter (130)
- Kun kapacitet: Ingen forsvarlig chaufførtildeling inden for 20 minutter (152); Ordren fylder mere, end der er plads til i bilerne (4)
- Efter (v0.5): Ingen realistisk leveringstid inden for åbningstiden (114); Ingen forsvarlig chaufførtildeling inden for 20 minutter (29); Ordren fylder mere, end der er plads til i bilerne (4); Kunden afviste foreslået leveringstid (1); Kunden svarede ikke på forslag om senere levering (1)
- v0.5 + intern kø: Ingen realistisk leveringstid inden for åbningstiden (142); Kunden afviste foreslået leveringstid (6); Ordren fylder mere, end der er plads til i bilerne (5); Kunden svarede ikke på forslag om senere levering (2)

## 1000 henvendelser, 16 chauffører

| Nøgletal | Før (v0.4.1) | Kun kapacitet | Efter (v0.5) | v0.5 + intern kø |
|---|---:|---:|---:|---:|
| Accepterede ordrer | 905,8 ± 8,2 (893) | 905,8 ± 8,2 (893) | 905,8 ± 8,2 (893) | 905,8 ± 8,2 (893) |
| Leverede ordrer | 744,8 ± 36,1 (683) | 720,8 ± 40,4 (679) | 710 ± 50,3 (652) | 712 ± 35,9 (663) |
| Manuelle sager | 121,8 ± 33,6 (177) | 144,8 ± 41,7 (192) | 156,8 ± 52,7 (210) | 155 ± 38,4 (199) |
| Åbne ved dagens slutning | 0,3 ± 0,4 (1) | 1 ± 1,7 (4) | 0 ± 0 (0) | 0 ± 0 (0) |
| Ordrer sat i intern kø | 0 ± 0 (0) | 0 ± 0 (0) | 0 ± 0 (0) | 143,5 ± 39,8 (177) |
| Ordrer tilbudt senere tidspunkt | 0 ± 0 (0) | 0 ± 0 (0) | 22,5 ± 24,6 (59) | 33,5 ± 30,5 (64) |
| Senere tidspunkter accepteret | 0 ± 0 (0) | 0 ± 0 (0) | 12,3 ± 13,6 (33) | 17 ± 14,7 (35) |
| Aftalte tidsrum overholdt | 0 ± 0 (0) | 0 ± 0 (0) | 8,3 ± 10,2 (25) | 13,8 ± 12,2 (30) |
| Leverede med aftalt tidsrum | 0 ± 0 (0) | 0 ± 0 (0) | 12,3 ± 13,6 (33) | 17 ± 14,7 (35) |
| Forsinkede (%) | 10,6 ± 1,3 (12,6) | 11,7 ± 2,2 (15,5) | 13,7 ± 2,4 (17,6) | 12,8 ± 2,5 (17) |
| Forsinkelsesminutter | 677,5 ± 71,6 (774) | 736 ± 145 (885) | 975,5 ± 84,9 (1.094) | 792,3 ± 88,1 (871) |
| P90 forsinkelse (min) | 10,2 ± 1,5 (12) | 12 ± 0,8 (13,1) | 14,4 ± 0,7 (15,1) | 11,9 ± 1 (13,1) |
| Gns. leveringstid (min) | 63,7 ± 4,9 (69,5) | 70,9 ± 9,3 (84,1) | 73,7 ± 10,6 (87,4) | 77,5 ± 8,9 (88,1) |
| Lageropfyldninger | 107 ± 15,3 (130) | 123,3 ± 34,9 (177) | 120,3 ± 27,1 (162) | 122,5 ± 26,4 (159) |
| Kapacitetsproblemer | 0,3 ± 0,4 (1) | 113,3 ± 101,2 (280) | 110,8 ± 98,4 (275) | 112,5 ± 84,6 (250) |
| Ledelsesindgreb | 82,3 ± 8,9 (95) | 104,3 ± 32,6 (154) | 101,3 ± 23,7 (137) | 102,5 ± 23,6 (135) |
| Fejlede/uafklarede | 425,5 ± 57,8 (522) | 476,5 ± 90,2 (592) | 496,3 ± 106,7 (605) | 578,3 ± 80,1 (669) |

**Manuelle sager pr. årsag (sum over seeds):**

- Før (v0.4.1): Ingen forsvarlig chaufførtildeling inden for 20 minutter (487)
- Kun kapacitet: Ingen forsvarlig chaufførtildeling inden for 20 minutter (576); Ordren fylder mere, end der er plads til i bilerne (3)
- Efter (v0.5): Ingen realistisk leveringstid inden for åbningstiden (348); Ingen forsvarlig chaufførtildeling inden for 20 minutter (258); Kunden afviste foreslået leveringstid (11); Kunden svarede ikke på forslag om senere levering (7); Ordren fylder mere, end der er plads til i bilerne (3)
- v0.5 + intern kø: Ingen realistisk leveringstid inden for åbningstiden (591); Kunden afviste foreslået leveringstid (18); Kunden svarede ikke på forslag om senere levering (9); Ordren fylder mere, end der er plads til i bilerne (2)
