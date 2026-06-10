'use strict';

/**
 * WARSTWA SERWEROWA  (rozdz. 3.3)
 *
 * Model klient-serwer oparty na Node.js. Spina ze soba: symulator (zrodlo danych),
 * relacyjna baze (historia odczytow), silnik decyzyjny (logika) i REST/SSE API
 * obslugujace dashboard. Symulator jest podpiety jako wymienne zrodlo - na jego miejsce
 * mozna wstawic realne sondy IoT bez zmian w silniku decyzyjnym.
 */

const path = require('path');
const express = require('express');

const db = require('./db');
const engine = require('./decisionEngine');
const { Simulator } = require('./simulator');

const herd = require('../config/herd.json');
const feeds = require('../config/feeds.json');
const params = require('../config/params.json');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const feedById = new Map(feeds.pasze.map((f) => [f.id, f]));

// Stan biezacy per zbiornik (w pamieci) + stan blokady dla histerezy silnika.
const tankState = new Map(
  herd.zbiorniki.map((t) => [t.id, { prevBlocked: false, reading: null, decision: null }])
);

const sim = new Simulator(herd.zbiorniki, { minutesPerTick: 20, startHour: 5 });

// Klienci SSE (push na zywo)
const sseClients = new Set();

/**
 * Przelicza decyzje dla zbiornika na podstawie danego odczytu i utrwala stan.
 * Wspoldzielone przez tick symulatora oraz reczne zmiany obsady/paszy, dzieki czemu
 * dawka kg/dobe przelicza sie natychmiast — takze gdy symulacja jest wstrzymana.
 */
function evaluateTank(tank, reading) {
  const state = tankState.get(tank.id);

  const decision = engine.evaluate(
    {
      massG: tank.masaJednostkowaG,
      fishCount: tank.liczbaRyb,
      temperature: reading.temperature,
      oxygen: reading.oxygen,
    },
    { blocked: state.prevBlocked }
  );

  // ekonomia: oszczednosc wzgledem "glupiego" karmnika podajacego pelna dawke bazowa
  const feed = feedById.get(tank.paszaId);
  const savedKg = round(decision.baseDoseKg - decision.recommendedDoseKg, 2);
  const economics = feed
    ? {
        feedNazwa: `${feed.producent} ${feed.nazwa}`,
        cenaPlnKg: feed.cenaPlnKg,
        kosztRekomendacjiPln: round(decision.recommendedDoseKg * feed.cenaPlnKg, 2),
        oszczednoscKg: savedKg,
        oszczednoscPln: round(savedKg * feed.cenaPlnKg, 2),
      }
    : null;

  state.prevBlocked = decision.blocked;
  state.reading = reading;
  state.decision = decision;
  state.economics = economics;

  db.saveDecision({
    tankId: tank.id,
    ts: reading.ts,
    status: decision.status,
    finalMult: decision.finalMultiplier,
    recommendedKg: decision.recommendedDoseKg,
    stressIndex: decision.stressIndex,
  });
}

/** Natychmiastowe przeliczenie na ostatnim odczycie (po zmianie obsady/paszy). */
function recomputeTank(tank) {
  const state = tankState.get(tank.id);
  if (!state.reading) return; // brak odczytu jeszcze — nie ma na czym liczyc
  evaluateTank(tank, state.reading);
  broadcast();
}

sim.on('reading', (reading) => {
  const tank = herd.zbiorniki.find((t) => t.id === reading.tankId);
  evaluateTank(tank, reading); // najpierw decyzja (potrzebna dawka do zapisu)
  reading.recommendedKg = tankState.get(tank.id).decision.recommendedDoseKg;
  db.saveReading(reading); // zapis odczytu wraz z rekomendowana dawka
  broadcast();
});

function buildSnapshot() {
  const env = sim.lastEnv || { temperature: 26, oxygen: 7.5 };
  return {
    gospodarstwo: herd.gospodarstwo,
    scenariusz: { aktualny: sim.scenario, godzinaSym: round(sim.hour, 1), dostepne: sim.listScenarios() },
    symulacjaDziala: sim.running,
    ambient: { temperature: round(env.temperature, 1), oxygen: round(env.oxygen, 1) },
    manualAktywny: sim.manual != null,
    paszeDostepne: feeds.pasze.map((f) => ({
      id: f.id,
      etykieta: `${f.producent} ${f.nazwa} · ${f.granulacjaMm} mm · ${f.bialkoProcent}% B`,
      etap: f.etap,
    })),
    zbiorniki: herd.zbiorniki.map((t) => {
      const s = tankState.get(t.id);
      const feed = feedById.get(t.paszaId);
      return {
        id: t.id,
        nazwa: t.nazwa,
        etap: t.etap,
        powierzchniaHa: t.powierzchniaHa,
        liczbaRyb: t.liczbaRyb,
        masaJednostkowaG: t.masaJednostkowaG,
        paszaId: t.paszaId,
        pasza: feed ? { nazwa: `${feed.producent} ${feed.nazwa}`, granulacjaMm: feed.granulacjaMm, bialkoProcent: feed.bialkoProcent } : null,
        reading: s.reading,
        decision: s.decision,
        economics: s.economics,
        historia: db.getRecentReadings(t.id, 40),
      };
    }),
  };
}

function broadcast() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---------- REST API ----------

app.get('/api/state', (_req, res) => res.json(buildSnapshot()));

app.get('/api/feeds', (_req, res) => res.json(feeds));

app.get('/api/params', (_req, res) => res.json(params));

app.get('/api/scenarios', (_req, res) =>
  res.json({ aktualny: sim.scenario, dostepne: sim.listScenarios() })
);

app.post('/api/scenario', (req, res) => {
  try {
    sim.setScenario(req.body.scenario);
    res.json({ ok: true, scenariusz: sim.scenario });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sim/running', (req, res) => {
  if (req.body.running) sim.resume();
  else sim.stop();
  res.json({ ok: true, running: sim.running });
  broadcast(); // po pauzie nie ma odczytow — wymus aktualizacje stanu przycisku w UI
});

app.post('/api/time', (req, res) => {
  let h;
  if (typeof req.body.hour === 'string' && req.body.hour.includes(':')) {
    const [hh, mm] = req.body.hour.split(':').map(Number);
    h = hh + (mm || 0) / 60;
  } else {
    h = Number(req.body.hour);
  }
  if (!Number.isFinite(h)) return res.status(400).json({ ok: false, error: 'Nieprawidlowa godzina' });
  sim.setTime(h);
  res.json({ ok: true, godzinaSym: round(sim.hour, 1) });
});

app.post('/api/manual', (req, res) => {
  if (req.body.reset) {
    sim.setManual(null);
    return res.json({ ok: true, manual: null });
  }
  const overrides = {};
  if (req.body.temperature != null) overrides.temperature = Number(req.body.temperature);
  if (req.body.oxygen != null) overrides.oxygen = Number(req.body.oxygen);
  sim.setManual(overrides);
  res.json({ ok: true, manual: overrides });
});

app.post('/api/tanks/:id/stock', (req, res) => {
  const tank = herd.zbiorniki.find((t) => t.id === req.params.id);
  if (!tank) return res.status(404).json({ ok: false, error: 'Nieznany zbiornik' });
  const masa = Number(req.body.masaJednostkowaG);
  const liczba = Number(req.body.liczbaRyb);
  if (!Number.isFinite(masa) || masa <= 0) return res.status(400).json({ ok: false, error: 'Nieprawidlowa masa' });
  if (!Number.isFinite(liczba) || liczba <= 0) return res.status(400).json({ ok: false, error: 'Nieprawidlowa liczba ryb' });
  tank.masaJednostkowaG = Math.round(masa);
  tank.liczbaRyb = Math.round(liczba);
  recomputeTank(tank); // natychmiastowe przeliczenie dawki, bez czekania na tick
  res.json({ ok: true, masaJednostkowaG: tank.masaJednostkowaG, liczbaRyb: tank.liczbaRyb });
});

app.post('/api/tanks/:id/feed', (req, res) => {
  const tank = herd.zbiorniki.find((t) => t.id === req.params.id);
  if (!tank) return res.status(404).json({ ok: false, error: 'Nieznany zbiornik' });
  if (!feedById.has(req.body.feedId)) return res.status(400).json({ ok: false, error: 'Nieznana pasza' });
  tank.paszaId = req.body.feedId;
  recomputeTank(tank); // natychmiastowe przeliczenie ekonomii
  res.json({ ok: true, paszaId: tank.paszaId });
});

app.get('/api/tanks/:id/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 500);
  res.json(db.getRecentReadings(req.params.id, limit));
});

// Strumien zdarzen na zywo (Server-Sent Events)
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function round(x, dp) {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

sim.start(1500);

app.listen(PORT, () => {
  console.log(`\n  Carp Feeder DSS  ->  http://localhost:${PORT}\n`);
  console.log(`  Zbiorniki: ${herd.zbiorniki.map((t) => t.id).join(', ')}`);
  console.log(`  Scenariusz startowy: ${sim.scenario}\n`);
});

module.exports = { app, sim, buildSnapshot };
