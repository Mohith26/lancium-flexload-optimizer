// Runs backtests off the main thread so the console stays responsive.
import { prepareData, backtest } from './model.js';

let dataPromise = null;
function getData() {
  if (!dataPromise) {
    dataPromise = fetch(new URL('../data/ercot_lz_west_2026.json', import.meta.url))
      .then((r) => r.json())
      .then((j) => ({ data: prepareData(j), json: j }));
  }
  return dataPromise;
}

self.onmessage = async (ev) => {
  const { type, id, params, opts } = ev.data;
  try {
    const { data, json } = await getData();
    if (type === 'run') {
      const t0 = performance.now();
      const result = backtest(data, params, { ...opts, keepHourly: 'optimizer' });
      const ms = performance.now() - t0;
      self.postMessage({
        type: 'result', id, result, ms,
        meta: {
          zone: json.zone, sources: json.sources, rtcb: json.rtc_b_go_live,
          first: data.days[0].date, last: data.days[data.days.length - 1].date,
          months: [...new Set(data.days.map((d) => d.date.slice(0, 7)))],
        },
      });
    } else if (type === 'sens') {
      const values = opts.values;
      const rows = [];
      for (let i = 0; i < values.length; i++) {
        const r = backtest(data, { ...params, computeValue: values[i] }, { ...opts, strategies: ['priceCap', 'asMax', 'optimizer', 'oracle'], keepHourly: false });
        rows.push({ v: values[i], ...Object.fromEntries(Object.entries(r.strategies).map(([k, s]) => [k, s.totals.flexValue])) });
        self.postMessage({ type: 'sensProgress', id, done: i + 1, total: values.length });
      }
      self.postMessage({ type: 'sens', id, rows });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
