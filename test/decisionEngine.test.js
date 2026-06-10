'use strict';

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/decisionEngine');

const HERD = { massG: 450, fishCount: 1000 }; // kroczek K2, biomasa 450 kg

test('optimum termiczno-tlenowe daje pelna dawke (mnoznik 1.0, OPTYMALNY)', () => {
  const d = engine.evaluate({ ...HERD, temperature: 26, oxygen: 8 });
  assert.strictEqual(d.status, 'OPTYMALNY');
  assert.strictEqual(d.tempMultiplier, 1);
  assert.strictEqual(d.oxyMultiplier, 1);
  assert.strictEqual(d.finalMultiplier, 1);
  assert.ok(d.recommendedDoseKg > 0);
  assert.strictEqual(d.recommendedDoseKg, d.baseDoseKg);
});

test('wybor etapu wagowego K1/K2/K3 wg masy ryby', () => {
  assert.strictEqual(engine.selectStage(30).etap, 'K1');
  assert.strictEqual(engine.selectStage(450).etap, 'K2');
  assert.strictEqual(engine.selectStage(1650).etap, 'K3');
});

test('upal 31 C obniza mnoznik T do ~0.43 (status SUBOPTYMALNY)', () => {
  const d = engine.evaluate({ ...HERD, temperature: 31, oxygen: 8 });
  assert.ok(d.tempMultiplier > 0.35 && d.tempMultiplier < 0.5, `T-mult=${d.tempMultiplier}`);
  assert.strictEqual(d.status, 'SUBOPTYMALNY');
});

test('stres cieplny >= 32.5 C wyzwala twarda blokade (KRYTYCZNY, 0 kg)', () => {
  const d = engine.evaluate({ ...HERD, temperature: 33, oxygen: 8 });
  assert.strictEqual(d.status, 'KRYTYCZNY');
  assert.strictEqual(d.blocked, true);
  assert.strictEqual(d.recommendedDoseKg, 0);
});

test('krytyczny deficyt tlenu < 3 mg/l nadpisuje idealna temperature (fail-safe)', () => {
  const d = engine.evaluate({ ...HERD, temperature: 26, oxygen: 2.5 });
  assert.strictEqual(d.status, 'KRYTYCZNY');
  assert.strictEqual(d.blocked, true);
  assert.strictEqual(d.recommendedDoseKg, 0);
});

test('miekkie hamowanie tlenowe: 4 mg/l przy 25 C tnie dawke ~50%', () => {
  const d = engine.evaluate({ ...HERD, temperature: 25, oxygen: 4 });
  assert.ok(d.oxyMultiplier > 0.4 && d.oxyMultiplier < 0.6, `O2-mult=${d.oxyMultiplier}`);
  assert.strictEqual(d.status, 'SUBOPTYMALNY');
});

test('indeks stresu letniego: ten sam tlen jest bezpieczny przy 15 C, deficytowy przy 28 C', () => {
  const cold = engine.evaluate({ ...HERD, temperature: 15, oxygen: 5 });
  const warm = engine.evaluate({ ...HERD, temperature: 28, oxygen: 5 });
  assert.ok(cold.oxyMultiplier > warm.oxyMultiplier, 'wymagany O2 powinien rosnac z temperatura');
  assert.ok(engine.requiredOxygen(28) > engine.requiredOxygen(15));
});

test('koniec sezonu zywieniowego ponizej 10 C: mnoznik T = 0', () => {
  const d = engine.evaluate({ ...HERD, temperature: 8, oxygen: 9 });
  assert.strictEqual(d.tempMultiplier, 0);
  assert.strictEqual(d.recommendedDoseKg, 0);
});

test('histereza: blokada utrzymana przy odbiciu tlenu do 3.5 mg/l (3 < O2 < 4)', () => {
  // bez histerezy 3.5 mg/l samo w sobie nie blokuje...
  const fresh = engine.evaluate({ ...HERD, temperature: 26, oxygen: 3.5 }, { blocked: false });
  assert.strictEqual(fresh.blocked, false);
  // ...ale jesli poprzednio bylismy zablokowani, blokada trzyma do progu 4.0 mg/l
  const held = engine.evaluate({ ...HERD, temperature: 26, oxygen: 3.5 }, { blocked: true });
  assert.strictEqual(held.blocked, true);
  assert.strictEqual(held.recommendedDoseKg, 0);
  // powyzej progu zdjecia blokada znika
  const released = engine.evaluate({ ...HERD, temperature: 26, oxygen: 4.5 }, { blocked: true });
  assert.strictEqual(released.blocked, false);
});
