'use strict';

/**
 * SILNIK DECYZYJNY  (rozdz. IV pracy)
 *
 * Czysta logika obliczeniowa, calkowicie odpieta od zrodla danych (symulator vs sonda IoT)
 * oraz od warstwy prezentacji. Na wejscie dostaje mase jednostkowa ryby (w), temperature (T)
 * i tlen rozpuszczony (O2); na wyjscie zwraca zmodyfikowana dawke pokarmowa i status.
 *
 * Lancuch decyzyjny:
 *   1. dawka bazowa  = biomasa * procent masy ciala (tablica wagowa wg Wojda 2006)
 *   2. mnoznik temperatury  (Horoszewicz 1973)         -> plynny "suwak" 0..1
 *   3. mnoznik tlenu z indeksem stresu letniego         -> miekkie hamowanie 0..1
 *   4. twarde blokady fail-safe (T i O2) z histereza    -> nadpisuja wynik do 0
 */

const params = require('../config/params.json');

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Liniowa interpolacja wartosci x z przedzialu [x0,x1] na [y0,y1]. */
function lerp(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  const t = clamp((x - x0) / (x1 - x0), 0, 1);
  return y0 + t * (y1 - y0);
}

/** Wybiera etap wagowy (K1/K2/K3) na podstawie masy jednostkowej ryby w gramach. */
function selectStage(massG) {
  const stages = params.etapyWagowe;
  for (const s of stages) {
    if (s.maxMasaG == null || massG < s.maxMasaG) return s;
  }
  return stages[stages.length - 1];
}

/**
 * Mnoznik temperatury wg progow termicznych Horoszewicz (1973).
 *  - 23-29 C            : 1.0 (optimum zerowania)
 *  - 29 -> 32.5 C       : liniowy spadek 1.0 -> 0.0 (przy 31 C ~0.43)
 *  - >= 32.5 C          : 0.0 (stres cieplny)
 *  - 23 -> 15 C         : spadek 1.0 -> 0.3 (metabolizm zwalnia)
 *  - 15 -> 10 C         : spadek 0.3 -> 0.0
 *  - < 10 C             : 0.0 (koniec sezonu zywieniowego)
 */
function temperatureMultiplier(T) {
  const t = params.temperatura;
  if (T >= t.optimumMin && T <= t.optimumMax) return 1.0;
  if (T > t.optimumMax) {
    if (T >= t.krytycznaGora) return 0.0;
    return lerp(T, t.optimumMax, t.krytycznaGora, 1.0, 0.0);
  }
  // ponizej optimum
  if (T >= 15) return lerp(T, 15, t.optimumMin, 0.3, 1.0);
  if (T >= t.koniecSezonu) return lerp(T, t.koniecSezonu, 15, 0.0, 0.3);
  return 0.0;
}

/**
 * Dynamiczny prog tlenowy (indeks stresu letniego, rozdz. 2.3):
 * w cieplejszej wodzie ryba potrzebuje wiecej tlenu, wiec wymagany O2 rosnie z temperatura.
 */
function requiredOxygen(T) {
  const o = params.tlen;
  const extra = Math.max(0, (T - o.tempReferencyjnaC) * o.wspolczynnikStresuTermicznego);
  return o.optimum + extra;
}

/**
 * Mnoznik tlenu (miekkie hamowanie, rozdz. 4.2):
 *  - O2 >= wymagany     : 1.0
 *  - krytyczny..wymagany: liniowy spadek 0..1
 *  - O2 <= krytyczny    : 0.0 (twarda blokada obsluzona osobno)
 */
function oxygenMultiplier(O2, T) {
  const o = params.tlen;
  const req = requiredOxygen(T);
  if (O2 >= req) return 1.0;
  if (O2 <= o.krytyczny) return 0.0;
  return lerp(O2, o.krytyczny, req, 0.0, 1.0);
}

/**
 * Glowna ewaluacja. prevState pozwala zaimplementowac histereze (rozdz. 4.3):
 * raz wlaczona blokada krytyczna zdejmowana jest dopiero gdy parametry trwale wroca
 * do bezpiecznego poziomu - zapobiega to "migotaniu" karmienia wokol progu.
 *
 * @param {Object} input  { massG, fishCount, temperature, oxygen }
 * @param {Object} prevState  { blocked: boolean }  - stan z poprzedniej iteracji
 * @returns {Object} pelna rekomendacja
 */
function evaluate(input, prevState = { blocked: false }) {
  const { massG, fishCount, temperature: T, oxygen: O2 } = input;
  const t = params.temperatura;
  const o = params.tlen;

  const stage = selectStage(massG);
  const biomassKg = (fishCount * massG) / 1000;
  const baseDoseKg = biomassKg * (stage.dawkaBazowaProcent / 100);

  const tempMult = temperatureMultiplier(T);
  const oxyMult = oxygenMultiplier(O2, T);
  const reqO2 = requiredOxygen(T);

  const reasons = [];

  // --- Twarde blokady fail-safe z histereza ---
  // Stan blokady "lepi sie": aktywny prog wlaczenia jest ostrzejszy niz prog zdjecia.
  const wasBlocked = !!prevState.blocked;

  const o2BlockOn = O2 < o.krytyczny;
  const o2BlockHold = wasBlocked && O2 < o.krytycznyHistereza; // utrzymanie do 4.0 mg/l
  const tempBlockOn = T >= t.krytycznaGora;
  const tempBlockHold = wasBlocked && T >= t.krytycznaGoraHistereza;

  const blocked = o2BlockOn || tempBlockOn || o2BlockHold || tempBlockHold;

  if (o2BlockOn) {
    reasons.push(`KRYTYCZNY deficyt tlenu (${O2.toFixed(1)} mg/l < ${o.krytyczny} mg/l) - blokada fail-safe.`);
  } else if (o2BlockHold) {
    reasons.push(`Tlen wraca, ale ponizej progu zdjecia blokady (${o.krytycznyHistereza} mg/l) - histereza utrzymuje wstrzymanie.`);
  }
  if (tempBlockOn) {
    reasons.push(`Stres cieplny (${T.toFixed(1)} C >= ${t.krytycznaGora} C) - blokada fail-safe.`);
  } else if (tempBlockHold && !o2BlockOn) {
    reasons.push(`Temperatura wraca, ale ponizej progu zdjecia blokady (${t.krytycznaGoraHistereza} C) - histereza utrzymuje wstrzymanie.`);
  }

  let finalMult;
  let status;

  if (blocked) {
    finalMult = 0.0;
    status = 'KRYTYCZNY';
  } else {
    finalMult = tempMult * oxyMult;
    if (finalMult >= 0.99) {
      status = 'OPTYMALNY';
      reasons.push('Warunki w optymalnym zakresie - pelna dawka.');
    } else if (finalMult <= 0.0001) {
      status = 'WSTRZYMANY';
      reasons.push('Mnoznik srodowiskowy = 0 (poza zakresem zerowania) - karmienie wstrzymane.');
    } else {
      status = 'SUBOPTYMALNY';
      if (tempMult < 0.99) {
        reasons.push(`Temperatura poza optimum -> mnoznik T = ${tempMult.toFixed(2)}.`);
      }
      if (oxyMult < 0.99) {
        reasons.push(`Obnizony tlen (wymagany ${reqO2.toFixed(1)} mg/l przy ${T.toFixed(1)} C) -> mnoznik O2 = ${oxyMult.toFixed(2)}.`);
      }
    }
  }

  const recommendedDoseKg = baseDoseKg * finalMult;
  const stressIndex = Math.round((1 - finalMult) * 100);

  return {
    stage: { etap: stage.etap, nazwa: stage.nazwa, bialko: stage.bialkoProcent },
    biomassKg: round(biomassKg, 1),
    baseDoseKg: round(baseDoseKg, 2),
    tempMultiplier: round(tempMult, 3),
    oxyMultiplier: round(oxyMult, 3),
    finalMultiplier: round(finalMult, 3),
    requiredOxygen: round(reqO2, 2),
    recommendedDoseKg: round(recommendedDoseKg, 2),
    stressIndex,
    status,
    blocked,
    reasons,
  };
}

function round(x, dp) {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

module.exports = {
  evaluate,
  selectStage,
  temperatureMultiplier,
  oxygenMultiplier,
  requiredOxygen,
};
