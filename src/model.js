// Flexible-load participation optimizer + backtester for an ERCOT data-center campus.
//
// Each operating day, before the Day-Ahead Market, the optimizer splits the campus's
// flexible (training) block, hour by hour, into:
//   p   planned off (bought nothing for it day-ahead)
//   e   "economic flex": runs, but is curtailed in real time if RT price > tau
//   a_k ancillary-service capacity per service k (REGUP, REGDN, RRS, ECRS, NSPIN),
//       paid the DAM clearing price; RRS/ECRS/NSPIN MW are curtailed when deployed
//   (the rest of the running block is plain firm-like load)
// and picks a day-ahead energy hedge B. It solves one scenario LP per hour that
// minimises  E[cost] + beta * CVaR_alpha[cost]  (Rockafellar-Uryasev), where the
// scenarios are the hour's empirical DA->RT spreads from a trailing, strictly
// non-anticipative window. Monthly SLA budgets (curtailed hours, minimum training
// throughput) are enforced online with a Lagrange multiplier lambda set from an
// empirical price quantile, plus hard caps in real time. Ramp limits apply in real time.
//
// Everything is normalised per MW of flexible load inside the LP and scaled back.

import { solveLP } from './simplex.js';

export const SERVICES = ['REGUP', 'REGDN', 'RRS', 'ECRS', 'NSPIN'];
export const DEPLOYABLE = ['RRS', 'ECRS', 'NSPIN']; // capacity that turns into a curtailment when deployed

export const DEFAULTS = {
  campusMW: 1200,          // total campus load (MW)
  flexMW: 300,             // interruptible training block (MW); the rest is firm inference
  computeValue: 150,       // $/MWh: value of one MWh of flexible compute (opportunity cost of curtailing)
  budgetHours: 40,         // SLA: max curtailed hour-equivalents of the flex block per month
  minThroughput: 0.95,     // SLA: min share of flex MWh delivered per month
  rampMWh: 150,            // ramp limit on scheduled/economic changes (MW per hour)
  alpha: 0.95,             // CVaR tail level
  beta: 0.5,               // CVaR weight (0 = risk-neutral)
  lookbackDays: 30,        // scenario window (days), lagged 2 days to stay non-anticipative
  safety: 0.8,             // share of the remaining curtailment budget the online threshold targets
  minReserveHE: 3,         // stop selling deployable AS when less budget than this remains (hour-equivalents)
  caps: { REGUP: 0.1, REGDN: 0.1, RRS: 0.3, ECRS: 0.3, NSPIN: 0.3 }, // max share of flex per service
  deployPrice: { RRS: 1000, ECRS: 400, NSPIN: 250 }, // deployment proxy: RT price ($/MWh) above which the award is deployed
  priceCap: null,          // naive curtailment trigger; null = computeValue (break-even)
};

// ---------- data ----------

export function prepareData(json) {
  const f = json.fields;
  const idx = Object.fromEntries(f.map((k, i) => [k, i]));
  const hours = json.rows.map((r) => ({
    date: r[idx.date], he: r[idx.he], da: r[idx.da], rt: r[idx.rt],
    mcpc: Object.fromEntries(SERVICES.map((s) => [s, r[idx[s]]])),
  }));
  const days = [];
  let cur = null;
  hours.forEach((h, i) => {
    if (!cur || cur.date !== h.date) { cur = { date: h.date, idx: [] }; days.push(cur); }
    cur.idx.push(i);
    h.day = days.length - 1;
  });
  // hour-ending -> list of hour indices, per day, for fast scenario lookup
  const byDayHE = days.map((d) => { const m = {}; d.idx.forEach((i) => { m[hours[i].he] = i; }); return m; });
  return { hours, days, byDayHE, meta: { zone: json.zone, rtcb: json.rtc_b_go_live, sources: json.sources } };
}

// Empirical scenarios for (day, he): RT-DA spreads at the same hour over days
// [day - lag - lookback + 1, day - lag]; lag = 2 so day d's plan never sees d-1's RT.
export function scenarioSpreads(data, day, he, lookback, lag = 2) {
  const out = [];
  for (let d = day - lag; d > day - lag - lookback && d >= 0; d--) {
    const i = data.byDayHE[d][he];
    if (i !== undefined) out.push(data.hours[i].rt - data.hours[i].da);
  }
  return out;
}

export function trailingRT(data, day, lookback, lag = 2) {
  const out = [];
  for (let d = day - lag; d > day - lag - lookback && d >= 0; d--) for (const i of data.days[d].idx) out.push(data.hours[i].rt);
  return out;
}

export function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// CVaR_alpha of losses = mean of the worst (1-alpha) share (fractional tail handled exactly).
export function cvar(losses, alpha) {
  const s = losses.slice().sort((a, b) => b - a);
  const tail = (1 - alpha) * s.length;
  let acc = 0, w = 0;
  for (let i = 0; i < s.length && w < tail - 1e-12; i++) { const take = Math.min(1, tail - w); acc += take * s[i]; w += take; }
  return w > 0 ? acc / w : s[0];
}

// ---------- the hourly LP ----------
// vars: 0 p, 1 e, 2 aREGUP, 3 aREGDN, 4 aRRS, 5 aECRS, 6 aNSPIN, 7 B, 8 etaP, 9 etaM, 10.. z_s
const V = { p: 0, e: 1, REGUP: 2, REGDN: 3, RRS: 4, ECRS: 5, NSPIN: 6, B: 7, etaP: 8, etaM: 9 };

// Per-scenario linear cost coefficients (per MW of flex) and constant term.
export function scenarioCost(hour, rS, P, lambda, firmRatio) {
  const v = P.computeValue + lambda;
  const tau = v;
  const coef = new Array(10).fill(0);
  coef[V.p] = v - rS;
  coef[V.e] = rS > tau ? v - rS : 0;
  coef[V.REGUP] = -hour.mcpc.REGUP;
  coef[V.REGDN] = -hour.mcpc.REGDN;
  for (const k of DEPLOYABLE) coef[V[k]] = -hour.mcpc[k] + (rS > P.deployPrice[k] ? v - rS : 0);
  coef[V.B] = hour.da - rS;
  return { coef, constant: (firmRatio + 1) * rS };
}

export function planHourLP(hour, rScen, P, lambda, limits) {
  const S = rScen.length;
  const firmRatio = (P.campusMW - P.flexMW) / P.flexMW;
  const n = 10 + S;
  const beta = P.beta, alpha = P.alpha;
  const c = new Array(n).fill(0);
  const A = [], b = [];
  const row = () => new Array(n).fill(0);

  const scen = rScen.map((r) => scenarioCost(hour, r, P, lambda, firmRatio));
  for (const s of scen) for (let j = 0; j < 10; j++) c[j] += s.coef[j] / S;
  c[V.etaP] += beta; c[V.etaM] -= beta;
  for (let s = 0; s < S; s++) c[10 + s] = beta / ((1 - alpha) * S);

  let r = row(); // p + e + up-capacity <= 1 (all must come out of the running block)
  r[V.p] = 1; r[V.e] = 1; r[V.REGUP] = 1; r[V.RRS] = 1; r[V.ECRS] = 1; r[V.NSPIN] = 1; A.push(r); b.push(1);
  r = row(); r[V.REGDN] = 1; r[V.p] = -1; A.push(r); b.push(0); // reg-down needs headroom
  for (const k of SERVICES) { r = row(); r[V[k]] = 1; A.push(r); b.push(limits.caps[k]); }
  r = row(); r[V.p] = 1; A.push(r); b.push(limits.pMax);
  r = row(); r[V.e] = 1; A.push(r); b.push(limits.eMax);
  r = row(); r[V.B] = 1; r[V.p] = 1; A.push(r); b.push(limits.noHedge ? 0 : firmRatio + 1); // hedge <= planned consumption
  for (let s = 0; s < S; s++) {
    r = row();
    for (let j = 0; j < 10; j++) r[j] = scen[s].coef[j];
    r[V.etaP] = -1; r[V.etaM] = 1; r[10 + s] = -1;
    A.push(r); b.push(-scen[s].constant);
  }
  const sol = solveLP({ c, A, b });
  if (sol.status !== 'optimal') throw new Error(`LP ${sol.status} on ${hour.date} HE${hour.he}`);
  const x = sol.x;
  const plan = { p: x[V.p], e: x[V.e], B: limits.noHedge ? 0 : x[V.B], a: {} };
  for (const k of SERVICES) plan.a[k] = x[V[k]];
  plan.tau = P.computeValue + lambda;
  plan.objective = sol.objective;
  return plan;
}

// ---------- real-time simulation and settlement ----------

function settle(hour, plan, st, P, H, { noRamp = false } = {}) {
  const firmRatio = (P.campusMW - P.flexMW) / P.flexMW;
  const R = noRamp ? Infinity : P.rampMWh / P.flexMW;
  const r = hour.rt;
  let dep = 0;
  for (const k of DEPLOYABLE) if (plan.a[k] > 0 && r > P.deployPrice[k]) dep += plan.a[k];
  // Planned-off and economic curtailment are voluntary: the campus can always choose to
  // run and buy the difference at the RT price. Take only as much as the remaining
  // monthly budget can absorb *including* the ramp-limited recovery hours it causes.
  // AS deployments (dep) are mandatory and always happen.
  const recovery = (deficit) => { let x = 0; if (R === Infinity) return 0; for (let k = 1; deficit - k * R > 1e-9; k++) x += deficit - k * R; return x; };
  const room = H - st.usedHE;
  const need = (c) => dep + c + recovery(dep + c);
  const fit = (want) => {
    if (want <= 0 || need(0) >= room) return 0;
    if (need(want) <= room) return want;
    let lo = 0, hi = want; for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (need(mid) <= room) lo = mid; else hi = mid; }
    return lo;
  };
  const pEff = fit(plan.p);
  const econ = r > plan.tau ? fit(pEff + plan.e) - pEff : 0;
  const regdnDeliverable = Math.min(plan.a.REGDN, pEff); // reg-down needs the planned headroom
  let target = 1 - pEff - econ;
  const lo = st.yPrev - R, hi = st.yPrev + R;
  const rampLimited = target < lo || target > hi;
  target = Math.min(Math.max(target, lo), hi);
  target = Math.min(Math.max(target, 0), 1);
  const y = Math.max(0, target - dep); // AS deployment is fast response: exempt from the ramp limit
  const curtail = 1 - y;
  st.usedHE += curtail;
  const violation = Math.max(0, st.usedHE - H) - st.violHE;
  st.violHE += violation;
  st.yPrev = y;
  let asRev = 0;
  for (const k of SERVICES) asRev += (k === 'REGDN' ? regdnDeliverable : plan.a[k]) * hour.mcpc[k];
  const F = P.flexMW;
  return {
    y, target, curtail, dep, econ,
    rampLimited,
    avoided: curtail * r * F,           // energy cost avoided by not consuming
    hedge: plan.B * (r - hour.da) * F,  // P&L of buying B day-ahead instead of at RT
    asRev: asRev * F,
    lost: curtail * P.computeValue * F, // compute value forgone
    cost: (plan.B * hour.da + (firmRatio + y - plan.B) * r - asRev + P.computeValue * curtail) * F,
    pEff,
    alwaysOn: (firmRatio + 1) * r * F,
    violation,
  };
}

const ZERO_PLAN = () => ({ p: 0, e: 0, B: 0, tau: Infinity, a: Object.fromEntries(SERVICES.map((s) => [s, 0])) });

export function monthlyBudget(P, hoursInMonth) {
  return Math.min(P.budgetHours, (1 - P.minThroughput) * hoursInMonth);
}

function monthKey(date) { return date.slice(0, 7); }

// ---------- strategies ----------
// Each strategy returns a plan for every hour of a day, given state.

function planOptimizer(data, day, P, st, H) {
  const hrs = data.days[day].idx;
  const Brem = H - st.usedHE;
  let lambda = 0;
  if (Brem > 1e-6) {
    const q = Math.min(1, (P.safety * Brem) / Math.max(1, st.hoursLeft));
    const tauStar = quantile(trailingRT(data, day, P.lookbackDays), 1 - q);
    lambda = Math.max(0, tauStar - P.computeValue);
  }
  // Chronological allocation of the remaining monthly budget within the day: each hour
  // may only plan curtailment / deployable AS out of what earlier hours have not
  // already claimed in expectation. Deployable AS is withheld entirely once fewer than
  // `minReserveHE` hour-equivalents remain, because a deployment cannot be refused.
  let left = Brem;
  return hrs.map((i) => {
    const h = data.hours[i];
    const spreads = scenarioSpreads(data, day, h.he, P.lookbackDays);
    const scen = spreads.length ? spreads.map((s) => h.da + s) : [h.da];
    const open = left > 1e-6;
    const limits = { caps: { ...P.caps }, pMax: open ? Math.min(1, left) : 0, eMax: open ? 1 : 0 };
    if (left < P.minReserveHE) for (const k of DEPLOYABLE) limits.caps[k] = 0;
    const plan = planHourLP(h, scen, P, lambda, limits);
    plan.lambda = lambda;
    // expected budget use of this plan under the scenarios
    let use = plan.p;
    for (const r of scen) {
      if (r > plan.tau) use += plan.e / scen.length;
      for (const k of DEPLOYABLE) if (r > P.deployPrice[k]) use += plan.a[k] / scen.length;
    }
    left -= use;
    return plan;
  });
}

function planPriceCap(data, day, P) {
  const tau = P.priceCap ?? P.computeValue;
  return data.days[day].idx.map(() => ({ ...ZERO_PLAN(), e: 1, tau }));
}

function planASMax(data, day, P) {
  return data.days[day].idx.map((i) => {
    const h = data.hours[i];
    const plan = ZERO_PLAN();
    let left = 1;
    const ups = ['REGUP', 'RRS', 'ECRS', 'NSPIN'].sort((a, b) => h.mcpc[b] - h.mcpc[a]);
    for (const k of ups) { const q = Math.min(P.caps[k], left); plan.a[k] = q; left -= q; }
    return plan;
  });
}

// Hindsight bound: same LP but with the realised RT price as the only scenario,
// risk-neutral, no day-ahead hedge (hindsight DA/RT arbitrage is not flex value),
// settled without the ramp limit, and with the monthly multiplier found by bisection
// so the month's curtailment fits the budget. A relaxation, i.e. an upper bound on the
// flexibility value any non-anticipative strategy could earn. Not a strategy.
function oracleMonthPlans(data, dayList, P, H) {
  const Pn = { ...P, beta: 0 };
  const limits = { caps: { ...P.caps }, pMax: 1, eMax: 1, noHedge: true };
  const planFor = (lambda) => dayList.map((d) => data.days[d].idx.map((i) => planHourLP(data.hours[i], [data.hours[i].rt], Pn, lambda, limits)));
  const usage = (plans) => {
    let u = 0;
    dayList.forEach((d, di) => data.days[d].idx.forEach((i, hi) => {
      const pl = plans[di][hi], r = data.hours[i].rt;
      let dep = 0; for (const k of DEPLOYABLE) if (r > P.deployPrice[k]) dep += pl.a[k];
      u += pl.p + (r > pl.tau ? pl.e : 0) + dep;
    }));
    return u;
  };
  let plans = planFor(0);
  if (usage(plans) <= H) return plans;
  let lo = 0, hi = 20000;
  for (let it = 0; it < 22; it++) {
    const mid = (lo + hi) / 2;
    if (usage(planFor(mid)) <= H) hi = mid; else lo = mid;
  }
  return planFor(hi);
}

export const STRATEGIES = {
  alwaysOn: 'Always on (RT index)',
  priceCap: 'Naive curtail above break-even',
  asMax: 'Naive max ancillary',
  optimizer: 'CVaR optimizer',
  oracle: 'Hindsight bound (no ramp, no hedge)',
};

// ---------- backtest ----------

export function backtest(data, params = {}, { strategies = Object.keys(STRATEGIES), startDate, endDate, keepHourly = 'optimizer' } = {}) {
  const P = { ...DEFAULTS, ...params, caps: { ...DEFAULTS.caps, ...(params.caps || {}) }, deployPrice: { ...DEFAULTS.deployPrice, ...(params.deployPrice || {}) } };
  const minDay = P.lookbackDays + 2;
  const dayIdx = data.days.map((d, i) => i).filter((i) => i >= minDay && (!startDate || data.days[i].date >= startDate) && (!endDate || data.days[i].date <= endDate));
  // group days by month
  const months = [];
  for (const d of dayIdx) {
    const mk = monthKey(data.days[d].date);
    if (!months.length || months[months.length - 1].key !== mk) months.push({ key: mk, days: [] });
    months[months.length - 1].days.push(d);
  }
  const out = { params: P, months: months.map((m) => m.key), strategies: {} };

  for (const name of strategies) {
    const res = { name, label: STRATEGIES[name], hourly: [], daily: [], monthly: [], totals: null };
    const st = { yPrev: 1 };
    for (const m of months) {
      const hoursInMonth = m.days.reduce((a, d) => a + data.days[d].idx.length, 0);
      const H = monthlyBudget(P, hoursInMonth);
      st.usedHE = 0; st.violHE = 0; st.hoursLeft = hoursInMonth;
      const mAgg = { key: m.key, budget: H, curtailHE: 0, benefit: 0, asRev: 0, violation: 0, hours: hoursInMonth };
      const oracle = name === 'oracle' ? oracleMonthPlans(data, m.days, P, H) : null;
      m.days.forEach((d, di) => {
        const hrs = data.days[d].idx;
        let plans;
        if (name === 'alwaysOn') plans = hrs.map(() => ZERO_PLAN());
        else if (name === 'priceCap') plans = planPriceCap(data, d, P);
        else if (name === 'asMax') plans = planASMax(data, d, P);
        else if (name === 'optimizer') plans = planOptimizer(data, d, P, st, H);
        else plans = oracle[di];
        const dAgg = { date: data.days[d].date, cost: 0, alwaysOn: 0, benefit: 0 };
        hrs.forEach((i, hi) => {
          const h = data.hours[i];
          const s = settle(h, plans[hi], st, P, H, { noRamp: name === 'oracle' });
          st.hoursLeft--;
          const benefit = s.alwaysOn - s.cost;
          dAgg.cost += s.cost; dAgg.alwaysOn += s.alwaysOn; dAgg.benefit += benefit;
          mAgg.curtailHE += s.curtail; mAgg.benefit += benefit; mAgg.asRev += s.asRev; mAgg.violation += s.violation;
          if (keepHourly === true || keepHourly === name) {
            res.hourly.push({ date: h.date, he: h.he, da: h.da, rt: h.rt, plan: plans[hi], ...s, benefit });
          }
          res._acc = res._acc || { avoided: 0, hedge: 0, asRev: 0, lost: 0, benefit: 0, curtailMWh: 0, flexMWh: 0, violation: 0, rampLimited: 0, curtailHours: 0 };
          const A = res._acc;
          A.avoided += s.avoided; A.hedge += s.hedge; A.asRev += s.asRev; A.lost += s.lost; A.benefit += benefit;
          A.curtailMWh += s.curtail * P.flexMW; A.flexMWh += P.flexMW; A.violation += s.violation;
          A.rampLimited += s.rampLimited ? 1 : 0; A.curtailHours += s.curtail > 1e-6 ? 1 : 0;
        });
        res.daily.push(dAgg);
      });
      res.monthly.push(mAgg);
    }
    const A = res._acc || { avoided: 0, hedge: 0, asRev: 0, lost: 0, benefit: 0, curtailMWh: 0, flexMWh: 1, violation: 0, rampLimited: 0, curtailHours: 0 };
    delete res._acc;
    const nMonths = Math.max(1, res.monthly.length);
    res.totals = {
      benefit: A.benefit, flexValue: A.avoided - A.lost + A.asRev, avoided: A.avoided, hedge: A.hedge, asRev: A.asRev, lost: A.lost,
      curtailHEperMonth: A.curtailMWh / P.flexMW / nMonths,
      curtailHoursPerMonth: A.curtailHours / nMonths,
      computeDelivered: 1 - A.curtailMWh / A.flexMWh,
      violationHE: A.violation,
      rampLimitedHours: A.rampLimited,
      cvarDailyCost: cvar(res.daily.map((d) => d.cost), 0.95),
      meanDailyCost: res.daily.reduce((a, d) => a + d.cost, 0) / Math.max(1, res.daily.length),
      days: res.daily.length,
    };
    out.strategies[name] = res;
  }
  return out;
}
