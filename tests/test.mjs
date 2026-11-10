// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveLP } from '../src/simplex.js';
import { prepareData, backtest, cvar, quantile, scenarioSpreads, planHourLP, DEFAULTS, SERVICES } from '../src/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'ercot_lz_west_2026.json'), 'utf8'));
const data = prepareData(json);
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// ---------- simplex ----------
test('simplex: textbook max problem', () => {
  // max 3x + 5y st x<=4, 2y<=12, 3x+2y<=18  -> 36 at (2,6)
  const r = solveLP({ c: [-3, -5], A: [[1, 0], [0, 2], [3, 2]], b: [4, 12, 18] });
  assert.equal(r.status, 'optimal');
  close(-r.objective, 36); close(r.x[0], 2); close(r.x[1], 6);
});

test('simplex: equality, >= and negative RHS', () => {
  // min x + 2y st x + y = 3, x - y >= -1, x <= 2.5  -> x=2.5,y=0.5, obj 3.5
  const r = solveLP({ c: [1, 2], A: [[1, 1], [1, -1], [1, 0]], b: [3, -1, 2.5], types: ['E', 'G', 'L'] });
  assert.equal(r.status, 'optimal');
  close(r.objective, 3.5); close(r.x[0], 2.5);
});

test('simplex: detects infeasible and unbounded', () => {
  assert.equal(solveLP({ c: [1], A: [[1], [1]], b: [1, 2], types: ['L', 'G'] }).status, 'infeasible');
  assert.equal(solveLP({ c: [-1, 0], A: [[0, 1]], b: [1] }).status, 'unbounded');
});

test('simplex: matches brute-force vertex enumeration on random 2-D LPs', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 200; t++) {
    const m = 3 + Math.floor(rnd() * 4);
    const A = [], b = [];
    for (let i = 0; i < m; i++) { A.push([rnd() * 2 - 0.5, rnd() * 2 - 0.5]); b.push(rnd() * 5 + 0.5); }
    A.push([1, 0]); b.push(10); A.push([0, 1]); b.push(10); // keep it bounded
    const c = [rnd() * 2 - 1, rnd() * 2 - 1];
    const r = solveLP({ c, A, b });
    // enumerate vertices (constraint pairs incl. x>=0, y>=0)
    const rows = A.map((a, i) => [a[0], a[1], b[i]]).concat([[-1, 0, 0], [0, -1, 0]]);
    let best = Infinity;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const [a1, b1, c1] = rows[i], [a2, b2, c2] = rows[j];
      const det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-12) continue;
      const x = (c1 * b2 - c2 * b1) / det, y = (a1 * c2 - a2 * c1) / det;
      if (rows.every(([p, q, s]) => p * x + q * y <= s + 1e-7)) best = Math.min(best, c[0] * x + c[1] * y);
    }
    assert.equal(r.status, 'optimal');
    close(r.objective, best, 1e-6);
  }
});

// ---------- risk + statistics helpers ----------
test('cvar: tail mean, including fractional tails', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  close(cvar(xs, 0.95), (100 + 99 + 98 + 97 + 96) / 5);
  close(cvar([0, 10], 0.75), 10);
  close(cvar([1, 2, 3, 4], 0.5), 3.5);
  close(quantile([1, 2, 3, 4, 5], 0.5), 3);
});

test('LP CVaR term equals the Rockafellar-Uryasev definition and beats any grid hedge', () => {
  // Hedge-only problem: flex products disabled, only the day-ahead hedge B and CVaR.
  const h = data.hours[5000];
  const P = { ...DEFAULTS, beta: 1, alpha: 0.9 };
  const scen = scenarioSpreads(data, h.day, h.he, 30).map((s) => h.da + s);
  const limits = { caps: Object.fromEntries(SERVICES.map((s) => [s, 0])), pMax: 0, eMax: 0 };
  const plan = planHourLP(h, scen, P, 0, limits);
  const firm = (P.campusMW - P.flexMW) / P.flexMW;
  const costOf = (B) => scen.map((r) => B * h.da + (firm + 1 - B) * r);
  const objOf = (B) => { const cs = costOf(B); return cs.reduce((a, x) => a + x, 0) / cs.length + P.beta * cvar(cs, P.alpha); };
  // The LP drops the constant (firm+1)*r_s from the mean term only.
  const constMean = scen.reduce((a, r) => a + (firm + 1) * r, 0) / scen.length;
  close(plan.objective + constMean, objOf(plan.B), 1e-7);
  let bestGrid = Infinity;
  for (let k = 0; k <= 400; k++) bestGrid = Math.min(bestGrid, objOf((firm + 1) * k / 400));
  assert.ok(objOf(plan.B) <= bestGrid + 1e-7);
});

// ---------- data ----------
test('data: real ERCOT LZ_WEST hours, all after RTC+B go-live', () => {
  assert.equal(json.zone, 'LZ_WEST');
  assert.ok(data.hours.length > 7000);
  assert.ok(data.hours.every((h) => h.date >= '2025-12-05'));
  assert.ok(data.days.every((d) => d.idx.length >= 23 && d.idx.length <= 24));
  assert.ok(data.hours.every((h) => Number.isFinite(h.da) && Number.isFinite(h.rt)));
});

test('scenarios are strictly non-anticipative (lagged 2 days)', () => {
  const day = 100, he = 17;
  const before = scenarioSpreads(data, day, he, 30);
  const clone = JSON.parse(JSON.stringify(json));
  const d2 = prepareData(clone);
  for (let d = day - 1; d < d2.days.length; d++) for (const i of d2.days[d].idx) { d2.hours[i].rt = 99999; d2.hours[i].da = -5; }
  assert.deepEqual(scenarioSpreads(d2, day, he, 30), before);
  assert.equal(before.length, 30);
});

// ---------- backtest ----------
const res = backtest(data, {}, { keepHourly: true, strategies: ['alwaysOn', 'priceCap', 'asMax', 'optimizer', 'oracle'] });

test('settlement identity: benefit = always-on cost - strategy cost = avoided + hedge + AS - lost', () => {
  for (const name of Object.keys(res.strategies)) {
    const s = res.strategies[name];
    for (const h of s.hourly.slice(0, 2000)) {
      close(h.alwaysOn - h.cost, h.avoided + h.hedge + h.asRev - h.lost, 1e-9);
      close(h.benefit, h.alwaysOn - h.cost, 1e-9);
    }
    const T = s.totals;
    close(T.benefit, T.avoided + T.hedge + T.asRev - T.lost, 1e-9);
  }
});

test('always-on earns nothing and curtails nothing', () => {
  const T = res.strategies.alwaysOn.totals;
  assert.equal(T.benefit, 0); assert.equal(T.computeDelivered, 1);
});

test('SLA: optimizer never exceeds the monthly curtailment budget, across compute values', () => {
  for (const v of [40, 80, 150, 500]) {
    const r = backtest(data, { computeValue: v }, { strategies: ['optimizer'], keepHourly: false });
    const s = r.strategies.optimizer;
    assert.equal(s.totals.violationHE, 0, `violation at v=${v}`);
    for (const m of s.monthly) assert.ok(m.curtailHE <= m.budget + 1e-6, `${m.key} ${m.curtailHE} > ${m.budget}`);
    assert.ok(s.totals.computeDelivered >= DEFAULTS.minThroughput - 1e-9);
  }
});

test('ramp limit respected on voluntary moves (AS deployments exempt)', () => {
  const R = DEFAULTS.rampMWh / DEFAULTS.flexMW;
  const hs = res.strategies.optimizer.hourly;
  let checked = 0;
  for (let i = 1; i < hs.length; i++) {
    if (hs[i].date.slice(0, 7) !== hs[i - 1].date.slice(0, 7)) continue;
    const voluntary = hs[i].target; // scheduled consumption before the mandatory deployment
    assert.ok(voluntary <= hs[i - 1].y + R + 1e-9, `ramp-up violated at ${hs[i].date} HE${hs[i].he}`);
    assert.ok(voluntary >= hs[i - 1].y - R - 1e-9, `ramp-down violated at ${hs[i].date} HE${hs[i].he}`);
    checked++;
  }
  assert.ok(checked > 5000);
});

test('ordering: hindsight bound >= optimizer flex value >= best naive at low compute value', () => {
  const r = backtest(data, { computeValue: 80 }, { strategies: ['priceCap', 'asMax', 'optimizer', 'oracle'], keepHourly: false });
  const fv = (k) => r.strategies[k].totals.flexValue;
  assert.ok(fv('oracle') >= fv('optimizer'));
  assert.ok(fv('optimizer') > Math.max(fv('priceCap'), fv('asMax')));
});

test('CVaR hedge lowers tail daily cost vs always-on', () => {
  const T = res.strategies.optimizer.totals, A = res.strategies.alwaysOn.totals;
  assert.ok(T.cvarDailyCost < A.cvarDailyCost);
});
