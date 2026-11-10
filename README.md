# Flex Participation Planner (concept for an ERCOT AI data-center campus)

**Live demo:** https://mohith26.github.io/lancium-flexload-optimizer/

An unofficial concept screen for an operator of a large, flexible AI data-center campus in ERCOT (think: an Abilene-type campus in load zone LZ_WEST). It decides, hour by hour, how much of the campus's **interruptible training block** to

- run with no offer,
- run as **economic flex** (curtail in real time if the RT price clears a threshold),
- sell as **ancillary-service capacity** (Reg-Up, Reg-Down, RRS, ECRS, Non-Spin) at the DAM clearing price,
- plan **off** day-ahead,

plus a day-ahead **energy hedge** for the whole campus, subject to tenant SLA constraints (max curtailed hours per month, minimum training throughput, ramp limits) and a **CVaR** risk term. It then replays every decision against **real public ERCOT prices** (Feb 2 to Nov 7 2026, all after the Dec 5 2025 RTC+B go-live) and compares it with naive rules and a hindsight bound.

> Unofficial concept demo by Mohith Gajjela. Not affiliated with Lancium. Prices are real public ERCOT data; the campus parameters are synthetic.

## Why this is interesting

Flexible large loads in ERCOT have three ways to monetise flexibility that compete for the same megawatts:

1. **Economic curtailment**: stop consuming when RT price > value of the compute. Pays only in a handful of scarcity hours.
2. **Ancillary capacity**: get paid every hour to *stand ready* to curtail. Keeps the GPUs running unless deployed, but every deployment burns tenant SLA budget, and a deployment cannot be refused.
3. **Hedging**: choose how much of the campus's energy to buy day-ahead versus at the RT index.

A MW sold as ECRS cannot also be held back for economic curtailment, and every curtailed hour (voluntary or deployed) comes out of a monthly SLA budget that has to last the whole month without knowing when the spikes come. That makes it an online, budget-constrained, risk-sensitive allocation problem, and the right answer changes with the value of the compute being interrupted. The backtest makes that concrete: "sell max ancillary" is the best naive rule at most compute values, but it leaves $1.8M to $3.0M on the table when compute is cheap ($40 to $80/MWh) because it never curtails economically, and it over-sells deployable capacity when compute is expensive ($1,000/MWh). The optimizer adapts across that range.

## Results on real ERCOT data (defaults)

`node scripts/report.mjs` (same code the UI runs). 1,200 MW campus, 300 MW interruptible block, compute value $150/MWh, budget 40 h/month, 95% min throughput, 150 MW/h ramp, CVaR95 weight 0.5. Window: 2026-02-02 to 2026-11-07, 279 days.

| Strategy | Flex value | Ancillary | Curtail net | Hedge P&L | Curtailed h/mo | Compute delivered | SLA overrun | CVaR95 daily cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Always on (RT index) | $0.00M | $0.00M | $0.00M | – | 0.0 | 100.00% | 0 | $2.54M |
| Naive: curtail above break-even | $2.34M | $0.00M | $2.34M | – | 6.4 | 99.04% | 0 | $2.39M |
| Naive: max ancillary | $5.04M | $3.84M | $1.20M | – | 1.3 | 99.80% | 0 | $2.42M |
| **CVaR optimizer** | **$5.42M** | $3.50M | $1.93M | $3.46M | 4.2 | 99.37% | 0 | **$1.91M** |
| Hindsight bound (no ramp, no hedge) | $6.38M | $3.67M | $2.71M | – | 6.1 | 99.09% | 0 | $2.35M |

*Flex value = energy cost avoided − compute value forgone + ancillary revenue.* The optimizer captures ~85% of the hindsight bound, beats the best naive rule by ~$0.4M over 279 days for a 300 MW block, never breaches the SLA, and its CVaR hedge cuts the 95% tail of daily campus energy cost by ~25% versus buying everything at the RT index.

Sensitivity (flex value, $M) across compute values, from the UI's sensitivity panel:

| Compute value | Curtail above break-even | Max ancillary | CVaR optimizer | Hindsight bound |
|---:|---:|---:|---:|---:|
| $40 | 2.06 | 5.47 | 8.46 | 12.37 |
| $80 | 4.31 | 5.31 | 7.13 | 8.73 |
| $150 | 2.34 | 5.04 | 5.42 | 6.38 |
| $250 | 1.06 | 4.64 | 4.63 | 5.15 |
| $500 | 0.05 | 3.66 | 3.32 | 4.09 |
| $1,000 | 0.00 | 1.70 | 2.06 | 3.66 |

Honest reading: the optimizer clearly wins when compute is cheap (lots of curtailment value to allocate under the budget) and when it is very expensive (it stops selling deployable capacity whose deployments would cost more than they pay). In the $250 to $500 band it ties or slightly trails "sell max ancillary", because its 30-day scenario window over-estimates deployment risk after the volatile January. That is the next thing to fix (see limitations).

## How it works

1. **Data** (`scripts/fetch_ercot.py`, stdlib only). Downloads three public ERCOT MIS archives (no login, no API key): 13060 *Historical DAM Load Zone and Hub Prices*, 13061 *Historical RTM Load Zone and Hub Prices* (15-minute, averaged to hourly), 13091 *Historical DAM Clearing Prices for Capacity* (REGUP, REGDN, RRS, NSPIN, ECRS). Extracts LZ_WEST to `data/ercot_lz_west_2026.json` (~400 KB, 7,463 hours).
2. **Scenarios** (`src/model.js`). For each delivery hour, the RT−DA spreads at the same hour over the previous 30 days, **lagged two days** so the day-ahead plan never uses RT prices it could not have known. Tested by mutating future data and checking the scenarios do not change.
3. **Hourly CVaR LP.** Variables per MW of flexible load: planned off `p`, economic flex `e`, capacity `a_k` per service, DA hedge `B`, and Rockafellar-Uryasev auxiliaries `eta, z_s`. Minimise `E[cost] + beta * CVaR_alpha[cost]` subject to: `p + e + sum(up capacity) <= 1`, `REGDN <= p` (headroom), per-service eligibility caps, `B <= planned consumption`. In each scenario, `e` curtails if RT > value + lambda, and RRS/ECRS/Non-Spin are deployed (curtailed) when RT exceeds the service's deployment-proxy price. Solved by `src/simplex.js`, a dependency-free two-phase simplex (Dantzig pricing with a Bland fallback), unit-tested against brute-force vertex enumeration.
4. **SLA as a price.** Each day, the remaining monthly curtailment budget becomes a multiplier lambda: the threshold is the empirical RT-price quantile at which, historically, the remaining budget would be used over the remaining hours (with a safety factor). Within a day, hours are planned chronologically against what earlier hours already claim in expectation, and deployable capacity is withheld when the budget gets thin.
5. **Real-time replay.** Settle each hour at the actual LZ_WEST RT price: mandatory deployments first, then voluntary curtailment only if the remaining budget can absorb it *including the ramp-limited recovery hours it causes*, then ramp limits on voluntary moves. If planned-off MW no longer fit the budget, the campus simply runs and pays RT (and forfeits the Reg-Down it can no longer provide).
6. **Benchmarks.** Always-on at the RT index; "curtail whenever RT > compute value" (first come, first served against the budget); "sell the max eligible ancillary capacity every hour"; and a **hindsight bound** that solves the same LP with the realised price as the only scenario, bisects lambda per month to fit the budget, has no hedge, and ignores ramp limits. It is a relaxation (upper bound), not a strategy.

Everything in the UI (`index.html`) is computed in the browser by the same modules, in a Web Worker. No numbers are hard-coded.

## About the UI

Lancium's Smart Response operations software is internal and has no public screenshots, so the screen is built as a new **Flex Participation** tab inside the only Lancium production web app with a public footprint: the **Lancium Compute portal** (portal.lancium.com). The look comes from archived copies of that portal's own application CSS and from in-app screenshots in Lancium's former Compute docs:

- Bootstrap 4.6.2 with Lancium's theme colors: primary `#656c79`, success `#288cd2`, info `#86c6f8`, warning `#143469`, danger `#70161e`, green `#009393`, text `#333`, borders `#ced4da`.
- Barlow for body text. Montserrat stands in for Gotham, which the portal uses for headings and nav but is a commercial font.
- Their gradient navbar (opacity .9) with the "blip" notch, crimson active tab, legend-style section labels on bordered containers, job-count style KPIs, `table-sm` with grey day rows, outline buttons, and Open Iconic icons.

The Lancium Compute logo in the navbar is Lancium's trademark. It appears only to show where the feature would live. This is an unofficial concept, not affiliated with Lancium.

## Run it

```bash
python3 -m http.server 8000      # then open http://localhost:8000
node --test tests/test.mjs       # 14 tests: simplex, CVaR, data integrity, non-anticipativity, SLA, ramp, settlement identity, orderings
node scripts/report.mjs [value]  # prints the backtest table
python3 scripts/fetch_ercot.py   # re-download the ERCOT archives and rebuild data/ (optional)
```

No build step, no dependencies beyond Node 18+ for tests and Chart.js from a CDN for the UI.

## Limitations (read these)

- **Deployment is a proxy.** ERCOT does not publish per-resource ancillary deployments, so RRS/ECRS/Non-Spin awards are assumed deployed in hours whose RT price exceeds a configurable level ($1,000 / $400 / $250 by default). Under RTC+B, real deployment follows SCED co-optimisation and frequency events; a real implementation should learn deployment probabilities from the operator's own telemetry.
- **Price-taker.** The campus is assumed not to move DAM clearing prices. 300 MW of ECRS is a material share of ERCOT's requirement, so large offers would depress MCPC. A supply-curve model is the obvious next step.
- **Settlement is simplified.** Energy is settled at the load-zone price; DAM AS awards are assumed physically provided, so RTC+B's real-time AS imbalance settlement nets to zero. No 4CP / transmission-charge avoidance, no Large Flexible Load or SB 6 curtailment obligations, no REP/QSE fees, no losses.
- **Regulation is energy-neutral.** Reg-Up/Reg-Down are treated as capacity products with no net energy or compute impact.
- **Hedge.** The day-ahead hedge is a per-hour decision between DAM and RT purchases. It earned money in this window; a risk-neutral version (`beta = 0`) loses money, which is the point of the CVaR term, but one 9-month window is not proof of a durable edge.
- **Scenario model.** 30 empirical spreads per hour is crude and over-reacts to January's volatility in the $250-$500 band. Better: conditional scenarios (weather, net load, reserve margin), and a multi-period LP so ramp limits are planned rather than only enforced.
- **One zone, one year.** LZ_WEST only, 2026 only.

## Layout

```
index.html              UI in the Lancium Compute portal shell (Bootstrap 4.6.2 + Chart.js from CDN)
assets/                 portal logo (Lancium trademark, app-chrome depiction only)
src/simplex.js          two-phase simplex
src/model.js            scenarios, hourly CVaR LP, SLA multiplier, RT replay, strategies, backtest
src/worker.js           runs backtests off the main thread
scripts/fetch_ercot.py  pulls the public ERCOT archives (stdlib only)
scripts/report.mjs      prints the backtest table
data/                   LZ_WEST hourly DA/RT prices + DAM AS clearing prices, 2026
tests/test.mjs          node --test
```

MIT licensed.
