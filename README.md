# Carp Feeder DSS 🐟

System wspomagania decyzji (Decision Support System) do **optymalizacji dawek pokarmowych karpia** (*Cyprinus carpio*) na różnych etapach odchowu, z uwzględnieniem dynamiki warunków termiczno-tlenowych.

Implementacja koncepcji z pracy końcowej *„Projekt systemu wspomagania decyzji do optymalizacji dawek pokarmowych karpia na różnych etapach odchowu…”* (M. D. Adamiec, UWM Olsztyn 2026).

![stack](https://img.shields.io/badge/Node.js-18+-green) ![db](https://img.shields.io/badge/DB-SQLite%20in--memory-blue) ![tests](https://img.shields.io/badge/tests-9%20passing-brightgreen)

---

## Idea

Tradycyjne tabele żywieniowe zakładają stabilność środowiska, której w stawie nie ma. Temperatura i tlen rozpuszczony zmieniają się w cyklu dobowym i pogodowym, a droga pasza ekstrudowana (FCR 1,2–1,5) sprawia, że błąd dawkowania kosztuje. Ten system **na bieżąco** koryguje dawkę na podstawie odczytów środowiskowych — zamiast karmić „na oko" co dwa tygodnie.

## Architektura (model klient–serwer)

```
┌──────────────┐   reading    ┌──────────────┐   decision   ┌──────────────┐
│  Symulator   │ ───events──► │  Silnik      │ ───────────► │  REST / SSE  │
│ (źródło danych)             │  decyzyjny   │              │     API      │
│  ⇄ IoT-ready │              │ (czysta      │              │              │
└──────────────┘              │  logika)     │              └──────┬───────┘
       │                      └──────────────┘                     │
       ▼ zapis                                                     ▼
┌──────────────┐                                          ┌──────────────┐
│  SQLite      │  (relacyjna historia odczytów:           │  Dashboard   │
│  in-memory   │   ts, tank_id, temperature, oxygen)      │  (przeglądarka)
└──────────────┘                                          └──────────────┘
```

- **Symulator odpięty od logiki** — emituje zdarzenia `reading`. Dla silnika nie ma znaczenia, czy dane pochodzą z symulatora, czy z realnej sondy IoT. Wymiana źródła nie wymaga zmian w algorytmie (rozdz. 3.3 pracy).
- **Dane rozdzielone na dwa tory** (rozdz. 3.3): rzadko zmienne parametry obsady → pliki **JSON** (`config/`); strumień odczytów środowiskowych → **relacyjna baza** (SQLite in-memory, semantyka jak PostgreSQL bez stawiania serwera).
- **Node.js** — nieblokująca pętla zdarzeń dobrze znosi ciągły strumień danych.

## Algorytm decyzyjny (rozdz. IV)

Dawka wynikowa = **dawka bazowa × mnożnik T × mnożnik O₂**, z nadrzędnym fail-safe.

| Krok | Reguła | Źródło |
|------|--------|--------|
| **Dawka bazowa** | % biomasy zależny od etapu wagowego (K1 6%, K2 3%, K3 1,8%) | Wojda 2006 |
| **Mnożnik T** | 23–29 °C → 1.0; powyżej spadek liniowy do 0 przy 32,5 °C; poniżej 10 °C → 0 (koniec sezonu) | Horoszewicz 1973 |
| **Mnożnik O₂** | miękkie hamowanie 3–`wymagany`; pełna dawka ≥ wymagany | Brylińska 2000 |
| **Indeks stresu letniego** | wymagany O₂ rośnie z temperaturą: `5 + (T−25)·0,15` | rozdz. 2.3 |
| **Fail-safe** | O₂ < 3 mg/l **lub** T ≥ 32,5 °C → dawka = **0** (nadpisuje wszystko) | Sommerville 2015 |
| **Histereza** | raz włączona blokada schodzi dopiero po trwałym powrocie (O₂ ≥ 4, T ≤ 31,5) — brak „migotania" | rozdz. 4.3 |

## Uruchomienie

```bash
npm install
npm start          # serwer + dashboard na http://localhost:3000
npm test           # 9 testów silnika decyzyjnego
```

Dashboard pokazuje na żywo (SSE): odczyty T/O₂, status, rekomendowaną dawkę, mnożniki, indeks stresu, wykres historyczny i **ekonomię** (oszczędność vs „głupi" karmnik zegarowy). Możesz przełączać scenariusze (optymalny / upał / przyducha / jesień) albo ręcznie sterować suwakami T i O₂, by sprawdzić przypadki brzegowe.

## Przykładowe pasze

`config/feeds.json` zawiera realistyczne pasze ekstrudowane stosowane w akwakulturze karpia: **Aller Aqua** (ALLER CARP EX / REX / PRO, ALLER BRONZE), **Alltech Coppens** (Carp Excellent), **Skretting** (Carp Vital) — z granulacją, % białka/tłuszczu, energią i ceną, dopasowane do etapów K1/K2/K3.

## API

| Metoda | Endpoint | Opis |
|--------|----------|------|
| GET | `/api/state` | pełny snapshot wszystkich zbiorników |
| GET | `/api/stream` | strumień SSE (push na żywo) |
| GET | `/api/feeds` | katalog pasz |
| GET | `/api/params` | progi i mnożniki algorytmu |
| GET | `/api/tanks/:id/history?limit=` | historia odczytów zbiornika |
| POST | `/api/scenario` | `{ "scenario": "upal" }` |
| POST | `/api/manual` | `{ "temperature": 34, "oxygen": 7 }` lub `{ "reset": true }` |

## Struktura

```
config/   herd.json · params.json · feeds.json   (parametry obsady, progi, pasze)
src/      decisionEngine.js  (rdzeń — czysta logika)
          simulator.js       (generator środowiska, IoT-ready)
          db.js              (relacyjna historia odczytów)
          server.js          (Express, REST + SSE)
public/   index.html · app.js · styles.css        (dashboard)
test/     decisionEngine.test.js                  (9 testów)
```

## Konfiguracja

- `PORT` — port serwera (domyślnie 3000)
- `DB_FILE` — podmiana bazy in-memory na plikową/trwałą (np. `DB_FILE=./readings.db`)
