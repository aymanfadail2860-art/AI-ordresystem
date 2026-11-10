# Før og efter – Etape 4.1

> **SIMULEREDE DATA.** Se [README.md](README.md) for årsagsanalyse, forudsætninger og begrænsninger.

Celler: gennemsnit ± standardafvigelse (dårligste) over 4 seeds med forskellige profiler (standard, store ordrer, spredte adresser, flere centrallagervarer).

**Før** = v0.4.0-strategien (C. økonomisk) med v0.4.0-regler (ingen påfyldning, dobbelttælling af beslutninger), kørt i den rettede simulator.
**Efter** = D. adaptiv hybrid med v0.4.1-regler.

## 100 henvendelser, 8 chauffører

| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |
|---|---:|---:|---:|
| Accepterede ordrer | 90,3 ± 1,3 (89) | 90,3 ± 1,3 (89) | 0 |
| Leverede ordrer | 88 ± 1,2 (86) | 88,8 ± 1,5 (87) | ✅ +0,8 (+1 %) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 |
| Eskaleret til manuel behandling | 0,5 ± 0,5 (1) | 0 ± 0 (0) | ✅ -0,5 (-100 %) |
| Omsætning (kr.) | 11.522 ± 2.414 (9.579) | 11.572 ± 2.539 (9.498) | ✅ +50 (+0 %) |
| Dækningsbidrag (kr.) | 7.898 ± 1.245 (6.849) | 7.942 ± 1.320 (6.833) | ✅ +44 (+1 %) |
| Gns. leveringstid (min) | 38,9 ± 5,5 (43,8) | 26,2 ± 2,2 (28) | ✅ -12,6 (-33 %) |
| Forsinkede (%) | 9,4 ± 2,6 (13,6) | 6,8 ± 1,1 (8) | ✅ -2,6 (-28 %) |
| Forsinkelsesminutter | 113,8 ± 60,1 (179) | 32,8 ± 9 (48) | ✅ -81 (-71 %) |
| P90 forsinkelse (min) | 12,3 ± 3,6 (16,7) | 2,7 ± 2,4 (5,3) | ✅ -9,6 (-78 %) |
| Ændrede ETA'er til kunder | 11,5 ± 5,1 (18) | 7,5 ± 3,2 (12) | ✅ -4 (-35 %) |
| Køretid (min) | 907,8 ± 139,5 (1.136) | 1.016,8 ± 159,6 (1.282) | ⚠️ +109 (+12 %) |
| Lageropfyldninger | 36,3 ± 8,2 (45) | 25,3 ± 6,4 (32) | ✅ -11 (-30 %) |
| Ledelsesindgreb | 43,8 ± 5,1 (47) | 35,3 ± 2,7 (38) | ✅ -8,5 (-19 %) |
| Fejlede/uafklarede | 8,8 ± 13,4 (32) | 0,3 ± 0,4 (1) | ✅ -8,5 (-97 %) |

## 150 henvendelser, 8 chauffører

| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |
|---|---:|---:|---:|
| Accepterede ordrer | 134,8 ± 1,8 (133) | 134,8 ± 1,8 (133) | 0 |
| Leverede ordrer | 131,8 ± 1,9 (129) | 132,5 ± 2,1 (130) | ✅ +0,8 (+1 %) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 |
| Eskaleret til manuel behandling | 0 ± 0 (0) | 0 ± 0 (0) | 0 |
| Omsætning (kr.) | 17.338 ± 4.388 (14.178) | 17.459 ± 4.483 (14.103) | ✅ +121 (+1 %) |
| Dækningsbidrag (kr.) | 11.824 ± 2.299 (10.143) | 11.903 ± 2.352 (10.082) | ✅ +79 (+1 %) |
| Gns. leveringstid (min) | 38,5 ± 3,4 (43,2) | 26,7 ± 3,9 (32,6) | ✅ -11,8 (-31 %) |
| Forsinkede (%) | 8,8 ± 3,5 (14,7) | 5,1 ± 1,1 (6,7) | ✅ -3,7 (-42 %) |
| Forsinkelsesminutter | 115,5 ± 25,4 (154) | 60 ± 23 (99) | ✅ -55,5 (-48 %) |
| P90 forsinkelse (min) | 7,9 ± 2,8 (12,2) | 1,4 ± 1,8 (4,3) | ✅ -6,5 (-83 %) |
| Ændrede ETA'er til kunder | 13,5 ± 3,8 (20) | 7 ± 1,4 (9) | ✅ -6,5 (-48 %) |
| Køretid (min) | 1.307,3 ± 187 (1.629) | 1.421,8 ± 253,3 (1.860) | ⚠️ +114,5 (+9 %) |
| Lageropfyldninger | 44,8 ± 10,6 (59) | 29,3 ± 6,4 (36) | ✅ -15,5 (-35 %) |
| Ledelsesindgreb | 48,8 ± 7,3 (59) | 31 ± 6,5 (39) | ✅ -17,8 (-36 %) |
| Fejlede/uafklarede | 0 ± 0 (0) | 0 ± 0 (0) | 0 |

## 300 henvendelser, 8 chauffører

| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |
|---|---:|---:|---:|
| Accepterede ordrer | 272 ± 3,2 (268) | 272 ± 3,2 (268) | 0 |
| Leverede ordrer | 252,3 ± 14,1 (228) | 261,5 ± 5 (254) | ✅ +9,3 (+4 %) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 |
| Eskaleret til manuel behandling | 10,5 ± 13,4 (33) | 2,5 ± 2,7 (7) | ✅ -8 (-76 %) |
| Omsætning (kr.) | 33.513 ± 8.542 (24.871) | 34.536 ± 7.882 (27.642) | ✅ +1.024 (+3 %) |
| Dækningsbidrag (kr.) | 22.757 ± 4.550 (17.827) | 23.488 ± 4.047 (19.826) | ✅ +730 (+3 %) |
| Gns. leveringstid (min) | 63,1 ± 13,4 (80,2) | 46,5 ± 13 (67,9) | ✅ -16,7 (-26 %) |
| Forsinkede (%) | 11,6 ± 2 (14,5) | 11,4 ± 1,6 (13,8) | ✅ -0,2 (-2 %) |
| Forsinkelsesminutter | 269,5 ± 38,7 (313) | 202,3 ± 14,7 (216) | ✅ -67,3 (-25 %) |
| P90 forsinkelse (min) | 11,9 ± 0,8 (12,8) | 9,6 ± 0,5 (10,1) | ✅ -2,3 (-19 %) |
| Ændrede ETA'er til kunder | 45,5 ± 7,8 (57) | 34,5 ± 2,7 (39) | ✅ -11 (-24 %) |
| Køretid (min) | 2.460,5 ± 359,7 (3.032) | 2.514,5 ± 348,3 (3.104) | ⚠️ +54 (+2 %) |
| Lageropfyldninger | 64,3 ± 10,8 (77) | 41 ± 8,4 (52) | ✅ -23,3 (-36 %) |
| Ledelsesindgreb | 68 ± 9,7 (84) | 33 ± 4,6 (38) | ✅ -35 (-51 %) |
| Fejlede/uafklarede | 36,3 ± 36 (95) | 11,5 ± 18,2 (43) | ✅ -24,8 (-68 %) |

## 500 henvendelser, 10 chauffører

| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |
|---|---:|---:|---:|
| Accepterede ordrer | 452,5 ± 3,9 (447) | 452,5 ± 3,9 (447) | 0 |
| Leverede ordrer | 387,8 ± 26 (343) | 403,3 ± 29,1 (354) | ✅ +15,5 (+4 %) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0 ± 0 (0) | 0 |
| Eskaleret til manuel behandling | 47,5 ± 24,8 (89) | 32,5 ± 27,3 (77) | ✅ -15 (-32 %) |
| Omsætning (kr.) | 50.183 ± 12.267 (36.911) | 52.085 ± 12.320 (38.597) | ✅ +1.902 (+4 %) |
| Dækningsbidrag (kr.) | 34.367 ± 6.569 (26.540) | 35.676 ± 6.633 (27.566) | ✅ +1.309 (+4 %) |
| Gns. leveringstid (min) | 74,9 ± 7,4 (86) | 63,2 ± 8,1 (76) | ✅ -11,7 (-16 %) |
| Forsinkede (%) | 13,7 ± 2,7 (16,9) | 13,5 ± 1,1 (15,3) | ✅ -0,3 (-2 %) |
| Forsinkelsesminutter | 520,5 ± 97,7 (642) | 468 ± 82,2 (591) | ✅ -52,5 (-10 %) |
| P90 forsinkelse (min) | 14,5 ± 0,5 (15,1) | 11,3 ± 1 (12,9) | ✅ -3,2 (-22 %) |
| Ændrede ETA'er til kunder | 76,8 ± 15,8 (96) | 74,8 ± 6,4 (83) | ✅ -2 (-3 %) |
| Køretid (min) | 3.715,5 ± 339,3 (4.285) | 3.835,5 ± 311,4 (4.367) | ⚠️ +120 (+3 %) |
| Lageropfyldninger | 86,8 ± 14,3 (105) | 65 ± 13,1 (86) | ✅ -21,8 (-25 %) |
| Ledelsesindgreb | 88,5 ± 8,2 (97) | 53 ± 5,6 (59) | ✅ -35,5 (-40 %) |
| Fejlede/uafklarede | 174,5 ± 54,4 (268) | 120,5 ± 63,4 (216) | ✅ -54 (-31 %) |

## 1000 henvendelser, 16 chauffører

| Nøgletal | Før (C, v0.4.0-regler) | Efter (D, v0.4.1) | Ændring |
|---|---:|---:|---:|
| Accepterede ordrer | 905,8 ± 8,2 (893) | 905,8 ± 8,2 (893) | 0 |
| Leverede ordrer | 701,3 ± 29,2 (651) | 744,8 ± 36,1 (683) | ✅ +43,5 (+6 %) |
| Åbne ved dagens slutning | 0 ± 0 (0) | 0,3 ± 0,4 (1) | ⚠️ +0,3 |
| Eskaleret til manuel behandling | 163,8 ± 29,3 (213) | 121,8 ± 33,6 (177) | ✅ -42 (-26 %) |
| Omsætning (kr.) | 92.796 ± 22.263 (72.375) | 97.652 ± 21.755 (75.540) | ✅ +4.857 (+5 %) |
| Dækningsbidrag (kr.) | 63.283 ± 11.750 (51.430) | 66.782 ± 11.553 (53.806) | ✅ +3.499 (+6 %) |
| Gns. leveringstid (min) | 77,5 ± 8,9 (85,2) | 63,7 ± 4,9 (69,5) | ✅ -13,9 (-18 %) |
| Forsinkede (%) | 11 ± 2,3 (14,7) | 10,6 ± 1,3 (12,6) | ✅ -0,4 (-3 %) |
| Forsinkelsesminutter | 810 ± 158,1 (1.026) | 677,5 ± 71,6 (774) | ✅ -132,5 (-16 %) |
| P90 forsinkelse (min) | 12,4 ± 1,8 (14,2) | 10,2 ± 1,5 (12) | ✅ -2,2 (-18 %) |
| Ændrede ETA'er til kunder | 111,3 ± 23,5 (150) | 109,3 ± 19,5 (143) | ✅ -2 (-2 %) |
| Køretid (min) | 6.313,5 ± 768,6 (7.525) | 6.378,5 ± 592,1 (7.380) | ⚠️ +65 (+1 %) |
| Lageropfyldninger | 143,5 ± 23,1 (171) | 107 ± 15,3 (130) | ✅ -36,5 (-25 %) |
| Ledelsesindgreb | 144,3 ± 7,8 (151) | 82,3 ± 8,9 (95) | ✅ -62 (-43 %) |
| Fejlede/uafklarede | 539 ± 50,2 (620) | 425,5 ± 57,8 (522) | ✅ -113,5 (-21 %) |

# Alle fire strategier efter v0.4.1 (identiske input og regler)

## 100 henvendelser, 8 chauffører

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. Økonomisk (v0.4) | D. Adaptiv hybrid |
|---|---:|---:|---:|---:|
| Accepterede ordrer | **90,3 ± 1,3 (89)** | **90,3 ± 1,3 (89)** | **90,3 ± 1,3 (89)** | **90,3 ± 1,3 (89)** |
| Leverede ordrer | **89,3 ± 1,1 (88)** | 87,8 ± 0,8 (87) | 87,8 ± 1,8 (85) | 88,8 ± 1,5 (87) |
| Åbne ved dagens slutning | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** |
| Eskaleret til manuel behandling | 0,3 ± 0,4 (1) | 0,3 ± 0,4 (1) | 0,8 ± 0,4 (1) | **0 ± 0 (0)** |
| Omsætning (kr.) | **11.667 ± 2.494 (9.732)** | 11.478 ± 2.415 (9.643) | 11.529 ± 2.507 (9.480) | 11.572 ± 2.539 (9.498) |
| Dækningsbidrag (kr.) | **7.999 ± 1.284 (6.968)** | 7.872 ± 1.253 (6.904) | 7.895 ± 1.300 (6.778) | 7.942 ± 1.320 (6.833) |
| Gns. leveringstid (min) | 27,4 ± 3,1 (31,9) | 39,9 ± 4,5 (43,3) | 29,2 ± 3,9 (34,4) | **26,2 ± 2,2 (28)** |
| Forsinkede (%) | 8,7 ± 2,2 (12,5) | 12,3 ± 1,9 (13,8) | 8 ± 1,4 (9,4) | **6,8 ± 1,1 (8)** |
| Forsinkelsesminutter | 58 ± 18,2 (77) | 100 ± 31,8 (141) | 51,5 ± 8,1 (61) | **32,8 ± 9 (48)** |
| P90 forsinkelse (min) | 6,5 ± 2,4 (10,3) | 9,4 ± 2,2 (11,6) | 5,9 ± 1 (7,3) | **2,7 ± 2,4 (5,3)** |
| Ændrede ETA'er til kunder | 7,8 ± 3,9 (13) | 11,3 ± 2,8 (16) | **7,5 ± 1,5 (10)** | **7,5 ± 3,2 (12)** |
| Køretid (min) | 1.188,3 ± 248,4 (1.605) | **831,8 ± 129,7 (1.053)** | 884,5 ± 187 (1.207) | 1.016,8 ± 159,6 (1.282) |
| Lageropfyldninger | 31,5 ± 8,7 (42) | **24 ± 5,6 (32)** | 24,8 ± 4,7 (29) | 25,3 ± 6,4 (32) |
| Ledelsesindgreb | 40,3 ± 6,9 (48) | **30,5 ± 2,1 (34)** | 34,5 ± 2,7 (38) | 35,3 ± 2,7 (38) |
| Fejlede/uafklarede | **0,3 ± 0,4 (1)** | **0,3 ± 0,4 (1)** | 0,8 ± 0,4 (1) | **0,3 ± 0,4 (1)** |

## 150 henvendelser, 8 chauffører

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. Økonomisk (v0.4) | D. Adaptiv hybrid |
|---|---:|---:|---:|---:|
| Accepterede ordrer | **134,8 ± 1,8 (133)** | **134,8 ± 1,8 (133)** | **134,8 ± 1,8 (133)** | **134,8 ± 1,8 (133)** |
| Leverede ordrer | 131,3 ± 1,8 (129) | 132 ± 2 (130) | 131,5 ± 2,1 (129) | **132,5 ± 2,1 (130)** |
| Åbne ved dagens slutning | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** |
| Eskaleret til manuel behandling | 0,5 ± 0,9 (2) | **0 ± 0 (0)** | 0,5 ± 0,5 (1) | **0 ± 0 (0)** |
| Omsætning (kr.) | 17.274 ± 4.245 (14.004) | 17.427 ± 4.436 (14.103) | 17.337 ± 4.425 (13.979) | **17.459 ± 4.483 (14.103)** |
| Dækningsbidrag (kr.) | 11.779 ± 2.199 (10.011) | 11.873 ± 2.323 (10.082) | 11.821 ± 2.316 (10.002) | **11.903 ± 2.352 (10.082)** |
| Gns. leveringstid (min) | 27,2 ± 3,4 (32,3) | 39,4 ± 6 (47,1) | 30,3 ± 3,8 (34,1) | **26,7 ± 3,9 (32,6)** |
| Forsinkede (%) | 7,4 ± 0,9 (8,4) | 12 ± 2,9 (16,2) | 10,3 ± 1 (11,6) | **5,1 ± 1,1 (6,7)** |
| Forsinkelsesminutter | 82,3 ± 17,8 (100) | 150,8 ± 61,4 (196) | 149 ± 30,8 (194) | **60 ± 23 (99)** |
| P90 forsinkelse (min) | 5 ± 1,1 (6,1) | 8,9 ± 2,7 (11,7) | 9,5 ± 1,9 (11,1) | **1,4 ± 1,8 (4,3)** |
| Ændrede ETA'er til kunder | 11 ± 1,6 (13) | 19 ± 4,9 (25) | 18 ± 2,3 (22) | **7 ± 1,4 (9)** |
| Køretid (min) | 1.604,8 ± 262,6 (2.050) | **1.179 ± 204,5 (1.519)** | 1.203,3 ± 196,8 (1.544) | 1.421,8 ± 253,3 (1.860) |
| Lageropfyldninger | 38,5 ± 11,9 (54) | 30,8 ± 10,3 (45) | 31,3 ± 9,5 (43) | **29,3 ± 6,4 (36)** |
| Ledelsesindgreb | 37,8 ± 7,9 (46) | 34 ± 4,7 (40) | 33,5 ± 6,3 (44) | **31 ± 6,5 (39)** |
| Fejlede/uafklarede | 0,5 ± 0,9 (2) | **0 ± 0 (0)** | 0,8 ± 0,4 (1) | **0 ± 0 (0)** |

## 300 henvendelser, 8 chauffører

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. Økonomisk (v0.4) | D. Adaptiv hybrid |
|---|---:|---:|---:|---:|
| Accepterede ordrer | **272 ± 3,2 (268)** | **272 ± 3,2 (268)** | **272 ± 3,2 (268)** | **272 ± 3,2 (268)** |
| Leverede ordrer | 254,3 ± 16,5 (226) | 252 ± 17 (223) | 258 ± 9,9 (241) | **261,5 ± 5 (254)** |
| Åbne ved dagens slutning | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** |
| Eskaleret til manuel behandling | 7,8 ± 13,4 (31) | 9 ± 15 (35) | 4,8 ± 8,2 (19) | **2,5 ± 2,7 (7)** |
| Omsætning (kr.) | 33.619 ± 8.684 (24.275) | 33.533 ± 8.765 (24.362) | 34.266 ± 8.123 (26.726) | **34.536 ± 7.882 (27.642)** |
| Dækningsbidrag (kr.) | 22.846 ± 4.665 (17.433) | 22.767 ± 4.723 (17.458) | 23.265 ± 4.268 (19.029) | **23.488 ± 4.047 (19.826)** |
| Gns. leveringstid (min) | 58 ± 14 (81) | 61 ± 13,8 (84,2) | 48,6 ± 12,6 (69,2) | **46,5 ± 13 (67,9)** |
| Forsinkede (%) | **9,3 ± 1 (11,1)** | 16,9 ± 4,5 (23,3) | 12,5 ± 2,4 (16,2) | 11,4 ± 1,6 (13,8) |
| Forsinkelsesminutter | 258,3 ± 28,6 (300) | 439,5 ± 126,4 (565) | 316,3 ± 86,7 (436) | **202,3 ± 14,7 (216)** |
| P90 forsinkelse (min) | 10,5 ± 1,5 (11,9) | 16 ± 1,7 (17,9) | 12,1 ± 2,3 (14,1) | **9,6 ± 0,5 (10,1)** |
| Ændrede ETA'er til kunder | 39 ± 6 (45) | 59 ± 17,8 (86) | 44 ± 8,9 (56) | **34,5 ± 2,7 (39)** |
| Køretid (min) | 2.943,8 ± 315,9 (3.470) | **2.235,3 ± 319 (2.774)** | 2.299,3 ± 371,1 (2.937) | 2.514,5 ± 348,3 (3.104) |
| Lageropfyldninger | 49,8 ± 10 (60) | 44,3 ± 5,4 (48) | 46 ± 8,2 (56) | **41 ± 8,4 (52)** |
| Ledelsesindgreb | 43,5 ± 5,9 (49) | 39,8 ± 4,5 (43) | 39,3 ± 4,5 (44) | **33 ± 4,6 (38)** |
| Fejlede/uafklarede | 24,3 ± 40,8 (95) | 27 ± 46,2 (107) | 18,5 ± 30,3 (71) | **11,5 ± 18,2 (43)** |

## 500 henvendelser, 10 chauffører

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. Økonomisk (v0.4) | D. Adaptiv hybrid |
|---|---:|---:|---:|---:|
| Accepterede ordrer | **452,5 ± 3,9 (447)** | **452,5 ± 3,9 (447)** | **452,5 ± 3,9 (447)** | **452,5 ± 3,9 (447)** |
| Leverede ordrer | 379,8 ± 26,2 (335) | 390,8 ± 24,9 (349) | 398,5 ± 26 (354) | **403,3 ± 29,1 (354)** |
| Åbne ved dagens slutning | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** |
| Eskaleret til manuel behandling | 54,8 ± 24,3 (95) | 44 ± 23,3 (82) | 36,5 ± 24,6 (79) | **32,5 ± 27,3 (77)** |
| Omsætning (kr.) | 48.983 ± 12.190 (35.818) | 50.192 ± 11.818 (37.260) | 51.890 ± 13.044 (38.969) | **52.085 ± 12.320 (38.597)** |
| Dækningsbidrag (kr.) | 33.556 ± 6.646 (25.641) | 34.427 ± 6.314 (26.743) | 35.446 ± 7.060 (27.644) | **35.676 ± 6.633 (27.566)** |
| Gns. leveringstid (min) | 75,4 ± 7,6 (86,1) | 71,2 ± 5,8 (77) | 65,5 ± 5,2 (73,7) | **63,2 ± 8,1 (76)** |
| Forsinkede (%) | **10,1 ± 1,8 (11,1)** | 18 ± 2,7 (21,8) | 16 ± 2,3 (19,2) | 13,5 ± 1,1 (15,3) |
| Forsinkelsesminutter | **367,8 ± 74,6 (481)** | 772,8 ± 187,1 (1.093) | 714,3 ± 226,1 (1.018) | 468 ± 82,2 (591) |
| P90 forsinkelse (min) | **10,1 ± 2,1 (12,4)** | 16,1 ± 2,4 (19,9) | 15,2 ± 3,1 (20,1) | 11,3 ± 1 (12,9) |
| Ændrede ETA'er til kunder | **60,5 ± 4,7 (67)** | 99 ± 19,7 (133) | 90 ± 17,7 (116) | 74,8 ± 6,4 (83) |
| Køretid (min) | 4.371,8 ± 175,5 (4.649) | **3.407 ± 325,3 (3.958)** | 3.644 ± 297 (4.119) | 3.835,5 ± 311,4 (4.367) |
| Lageropfyldninger | 63,8 ± 9,9 (75) | **62,3 ± 11,4 (78)** | 69,8 ± 14,2 (89) | 65 ± 13,1 (86) |
| Ledelsesindgreb | 56 ± 6,8 (65) | 56,8 ± 6,1 (66) | 56,8 ± 7,8 (63) | **53 ± 5,6 (59)** |
| Fejlede/uafklarede | 186,8 ± 48 (265) | 157,5 ± 55,5 (238) | 132,5 ± 53 (220) | **120,5 ± 63,4 (216)** |

## 1000 henvendelser, 16 chauffører

| Nøgletal | A. Først-til-mølle | B. Korteste ekstra køretid | C. Økonomisk (v0.4) | D. Adaptiv hybrid |
|---|---:|---:|---:|---:|
| Accepterede ordrer | **905,8 ± 8,2 (893)** | **905,8 ± 8,2 (893)** | **905,8 ± 8,2 (893)** | **905,8 ± 8,2 (893)** |
| Leverede ordrer | 677 ± 41,4 (613) | 717,3 ± 37,6 (656) | 738 ± 44,5 (662) | **744,8 ± 36,1 (683)** |
| Åbne ved dagens slutning | **0 ± 0 (0)** | **0 ± 0 (0)** | **0 ± 0 (0)** | 0,3 ± 0,4 (1) |
| Eskaleret til manuel behandling | 186,8 ± 41,6 (246) | 147,8 ± 38,4 (205) | 127,5 ± 41,2 (198) | **121,8 ± 33,6 (177)** |
| Omsætning (kr.) | 87.021 ± 22.745 (62.962) | 92.878 ± 20.183 (71.245) | 97.429 ± 23.297 (73.913) | **97.652 ± 21.755 (75.540)** |
| Dækningsbidrag (kr.) | 59.682 ± 12.267 (45.656) | 63.570 ± 10.543 (50.934) | 66.495 ± 12.449 (52.558) | **66.782 ± 11.553 (53.806)** |
| Gns. leveringstid (min) | 80,7 ± 11,1 (92) | 77,4 ± 8,8 (86,5) | 68,5 ± 8,7 (82,1) | **63,7 ± 4,9 (69,5)** |
| Forsinkede (%) | **7,8 ± 2 (10,3)** | 15,7 ± 1,6 (17,4) | 14,4 ± 2,8 (19,2) | 10,6 ± 1,3 (12,6) |
| Forsinkelsesminutter | **456,5 ± 137,7 (662)** | 1.319,5 ± 239,7 (1.679) | 1.075 ± 203,6 (1.393) | 677,5 ± 71,6 (774) |
| P90 forsinkelse (min) | **9,4 ± 2,2 (12)** | 17,2 ± 3,3 (22,5) | 14,6 ± 1,4 (16,5) | 10,2 ± 1,5 (12) |
| Ændrede ETA'er til kunder | **77,5 ± 18,8 (104)** | 173,8 ± 17,9 (192) | 164,8 ± 31,4 (219) | 109,3 ± 19,5 (143) |
| Køretid (min) | 7.170,3 ± 542 (8.016) | **6.101 ± 675,8 (7.128)** | 6.196,5 ± 755,5 (7.478) | 6.378,5 ± 592,1 (7.380) |
| Lageropfyldninger | **101,8 ± 20,9 (130)** | 115,8 ± 18,5 (140) | 113,3 ± 19,3 (143) | 107 ± 15,3 (130) |
| Ledelsesindgreb | 87,5 ± 13 (103) | 97,8 ± 6,4 (107) | 90 ± 9,8 (106) | **82,3 ± 8,9 (95)** |
| Fejlede/uafklarede | 557,8 ± 90 (660) | 504,5 ± 65,7 (587) | 447,5 ± 87,6 (595) | **425,5 ± 57,8 (522)** |

## Hvor den adaptive strategi IKKE er bedst (gennemsnit)

- **100 henvendelser, 8 chauffører:** Leverede ordrer, Omsætning (kr.), Dækningsbidrag (kr.), Køretid (min), Lageropfyldninger, Ledelsesindgreb
- **150 henvendelser, 8 chauffører:** Køretid (min)
- **300 henvendelser, 8 chauffører:** Forsinkede (%), Køretid (min)
- **500 henvendelser, 10 chauffører:** Forsinkede (%), Forsinkelsesminutter, P90 forsinkelse (min), Ændrede ETA'er til kunder, Køretid (min), Lageropfyldninger
- **1000 henvendelser, 16 chauffører:** Åbne ved dagens slutning, Forsinkede (%), Forsinkelsesminutter, P90 forsinkelse (min), Ændrede ETA'er til kunder, Køretid (min), Lageropfyldninger
