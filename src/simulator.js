'use strict';

/**
 * SYMULATOR SRODOWISKA STAWOWEGO  (rozdz. 3.2)
 *
 * Generuje strumien odczytow temperatury i tlenu rozpuszczonego. Jest celowo odpiety
 * od silnika decyzyjnego - emituje zdarzenia 'reading', a serwer je konsumuje. Dzieki temu
 * w przyszlosci mozna podmienic symulator na realny modul IoT bez zmian w logice (rozdz. 3.3).
 *
 * Modeluje dobowa krzywa tlenowa (minimum nad ranem - fotosynteza ustaje w nocy, rozdz. 4.2)
 * oraz scenariusze brzegowe trudne do bezpiecznego wywolania na zywym obiekcie.
 */

const EventEmitter = require('events');

const SCENARIOS = {
  optymalny: {
    label: 'Optymalny (wiosna / wczesne lato)',
    baseTemp: 26,
    tempAmplitude: 2.0,
    baseOxygen: 7.5,
    oxygenAmplitude: 1.8,
  },
  upal: {
    label: 'Letni upal (stres termiczny)',
    baseTemp: 31.5,
    tempAmplitude: 2.2,
    baseOxygen: 5.2,
    oxygenAmplitude: 2.2,
  },
  przyducha: {
    label: 'Przyducha (nocny deficyt tlenu)',
    baseTemp: 28,
    tempAmplitude: 1.5,
    baseOxygen: 4.0,
    oxygenAmplitude: 3.4,
  },
  jesien: {
    label: 'Jesienne ochlodzenie (koniec sezonu)',
    baseTemp: 11,
    tempAmplitude: 2.0,
    baseOxygen: 9.0,
    oxygenAmplitude: 1.0,
  },
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

class Simulator extends EventEmitter {
  /**
   * @param {Array} tanks      lista zbiornikow z config/herd.json
   * @param {Object} opts      { minutesPerTick, startHour }
   */
  constructor(tanks, opts = {}) {
    super();
    this.tanks = tanks;
    this.minutesPerTick = opts.minutesPerTick ?? 20;
    this.simMinutes = (opts.startHour ?? 5) * 60; // start o swicie - tuz przy dolku tlenowym
    this.scenario = 'optymalny';
    this.manual = null; // { temperature, oxygen } - reczne nadpisanie z UI
    this.timer = null;
    // staly, lekki offset mikroklimatu per zbiornik (rozne powierzchnie/glebokosci)
    this.offsets = new Map(tanks.map((t, i) => [t.id, { temp: (i - 1) * 0.6, oxy: (1 - i) * 0.3 }]));
  }

  get hour() {
    return (this.simMinutes / 60) % 24;
  }

  /** Pozycja w dobie: -1 (najglebsza noc / dolek tlenowy ~5:00) .. +1 (popoludnie ~15:00). */
  _diurnal() {
    // przesuniecie tak, by minimum wypadalo ok. 5:00 rano
    const phase = ((this.hour - 5) / 24) * 2 * Math.PI;
    return -Math.cos(phase);
  }

  _environment() {
    const s = SCENARIOS[this.scenario];
    const d = this._diurnal();
    let temperature = s.baseTemp + d * s.tempAmplitude;
    // tlen: maksimum w dzien (fotosynteza), minimum nad ranem
    let oxygen = s.baseOxygen + d * s.oxygenAmplitude;
    // delikatny szum pomiarowy
    temperature += (Math.random() - 0.5) * 0.3;
    oxygen += (Math.random() - 0.5) * 0.2;

    if (this.manual) {
      if (this.manual.temperature != null) temperature = this.manual.temperature;
      if (this.manual.oxygen != null) oxygen = this.manual.oxygen;
    }
    return { temperature, oxygen };
  }

  tick() {
    const env = this._environment();
    this.lastEnv = env; // biezace warunki srodowiskowe (do synchronizacji UI)
    const ts = new Date().toISOString();
    for (const tank of this.tanks) {
      const off = this.offsets.get(tank.id);
      const reading = {
        tankId: tank.id,
        ts,
        simHour: round(this.hour, 2),
        temperature: round(clamp(env.temperature + off.temp, 0, 42), 2),
        oxygen: round(clamp(env.oxygen + off.oxy, 0, 14), 2),
      };
      this.emit('reading', reading);
    }
    this.simMinutes += this.minutesPerTick;
  }

  get running() {
    return this.timer != null;
  }

  start(intervalMs = 1500) {
    this.intervalMs = intervalMs;
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Wznawia symulacje bez natychmiastowego ticka (kontynuuje od zatrzymanego stanu). */
  resume() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs || 1500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ustawia zegar symulacji na podana godzine (liczba 0-24, np. 6.5 = 06:30). */
  setTime(hours) {
    const h = (((hours % 24) + 24) % 24);
    this.simMinutes = h * 60;
  }

  setScenario(name) {
    if (!SCENARIOS[name]) throw new Error(`Nieznany scenariusz: ${name}`);
    this.scenario = name;
    this.manual = null; // scenariusz wylacza reczne nadpisanie
  }

  setManual(overrides) {
    this.manual = overrides; // { temperature?, oxygen? } lub null
  }

  listScenarios() {
    return Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label }));
  }
}

function round(x, dp) {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

module.exports = { Simulator, SCENARIOS };
