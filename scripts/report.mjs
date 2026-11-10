// Prints the default backtest (same code path as the web UI). Usage: node scripts/report.mjs [computeValue]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareData, backtest, STRATEGIES } from '../src/model.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const data = prepareData(JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'ercot_lz_west_2026.json'), 'utf8')));
const v = process.argv[2] ? +process.argv[2] : undefined;
const t0 = Date.now();
const r = backtest(data, v ? { computeValue: v } : {}, { keepHourly: false });
const M = (x) => (x / 1e6).toFixed(2).padStart(7);
const days = r.strategies.optimizer.daily;
console.log(`window ${days[0].date} .. ${days[days.length - 1].date} (${days.length} days), compute value $${r.params.computeValue}/MWh, flex ${r.params.flexMW} MW of ${r.params.campusMW} MW, ${Date.now() - t0} ms`);
console.log('strategy                                   flex$M   AS$M  curtNet$M hedge$M  curtH/mo  compute  SLAover  CVaR95day$M');
for (const [k, s] of Object.entries(r.strategies)) {
  const T = s.totals;
  console.log(`${STRATEGIES[k].padEnd(40)} ${M(T.flexValue)} ${M(T.asRev)} ${M(T.avoided - T.lost)}   ${M(T.hedge)}   ${T.curtailHEperMonth.toFixed(1).padStart(5)}   ${(100 * T.computeDelivered).toFixed(2)}%   ${T.violationHE.toFixed(1).padStart(4)}    ${M(T.cvarDailyCost)}`);
}
