// Dense two-phase primal simplex (tableau form), dependency-free.
// Solves:  minimize c.x  subject to  A_i.x (<=|=|>=) b_i,  x >= 0.
// Small LPs only (tens of variables / constraints): one per market hour.
// Dantzig pricing with a switch to Bland's rule after a run of degenerate
// pivots, which guarantees termination.

const EPS = 1e-9;

export function solveLP({ c, A, b, types }, { maxIter = 5000 } = {}) {
  const m = A.length;
  const n = c.length;
  if (types == null) types = new Array(m).fill('L');

  // Normalize so every RHS is >= 0.
  const rowsA = [], rhs = [], tys = [];
  for (let i = 0; i < m; i++) {
    let t = types[i];
    if (b[i] < 0) {
      rowsA.push(A[i].map((v) => -v));
      rhs.push(-b[i]);
      t = t === 'L' ? 'G' : t === 'G' ? 'L' : 'E';
    } else {
      rowsA.push(A[i].slice());
      rhs.push(b[i]);
    }
    tys.push(t);
  }

  let nSlack = 0, nArt = 0;
  for (const t of tys) {
    if (t !== 'E') nSlack++;
    if (t !== 'L') nArt++;
  }
  const N = n + nSlack + nArt;
  const W = N + 1; // last column = RHS
  const T = new Float64Array(m * W);
  const basis = new Int32Array(m);
  const isArt = new Uint8Array(N);
  let s = n, a = n + nSlack;
  for (let i = 0; i < m; i++) {
    const row = i * W;
    for (let j = 0; j < n; j++) T[row + j] = rowsA[i][j];
    T[row + N] = rhs[i];
    if (tys[i] === 'L') { T[row + s] = 1; basis[i] = s; s++; }
    else if (tys[i] === 'G') { T[row + s] = -1; s++; T[row + a] = 1; isArt[a] = 1; basis[i] = a; a++; }
    else { T[row + a] = 1; isArt[a] = 1; basis[i] = a; a++; }
  }

  let iters = 0;

  function pivot(r, q) {
    const pr = r * W;
    const pv = T[pr + q];
    for (let j = 0; j < W; j++) T[pr + j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const ir = i * W;
      const f = T[ir + q];
      if (f !== 0) for (let j = 0; j < W; j++) T[ir + j] -= f * T[pr + j];
    }
    basis[r] = q;
  }

  // Run simplex for cost vector `cost` (length N). allowed[j] gates entering columns.
  function run(cost, allowed) {
    const d = new Float64Array(W); // reduced costs; d[N] = -objective
    for (let j = 0; j < W; j++) d[j] = j < N ? cost[j] : 0;
    for (let i = 0; i < m; i++) {
      const cb = cost[basis[i]];
      if (cb !== 0) for (let j = 0; j < W; j++) d[j] -= cb * T[i * W + j];
    }
    let degenerateRun = 0;
    for (;;) {
      if (++iters > maxIter) return 'iteration_limit';
      const bland = degenerateRun > 25;
      let q = -1, best = -EPS;
      for (let j = 0; j < N; j++) {
        if (!allowed[j]) continue;
        if (d[j] < best) { q = j; if (bland) break; best = d[j]; }
      }
      if (q < 0) return 'optimal';
      let r = -1, ratio = Infinity;
      for (let i = 0; i < m; i++) {
        const v = T[i * W + q];
        if (v > EPS) {
          const t = T[i * W + N] / v;
          if (t < ratio - 1e-12 || (Math.abs(t - ratio) <= 1e-12 && r >= 0 && basis[i] < basis[r])) { ratio = t; r = i; }
        }
      }
      if (r < 0) return 'unbounded';
      degenerateRun = ratio < 1e-12 ? degenerateRun + 1 : 0;
      pivot(r, q);
      const f = d[q];
      for (let j = 0; j < W; j++) d[j] -= f * T[r * W + j];
    }
  }

  // Phase 1: minimise the sum of artificials.
  if (nArt > 0) {
    const c1 = new Float64Array(N);
    for (let j = 0; j < N; j++) if (isArt[j]) c1[j] = 1;
    const st = run(c1, new Uint8Array(N).fill(1));
    if (st === 'iteration_limit') return { status: st, iters };
    let infeas = 0;
    for (let i = 0; i < m; i++) if (isArt[basis[i]]) infeas += T[i * W + N];
    if (infeas > 1e-7) return { status: 'infeasible', iters };
    // Drive zero-level artificials out of the basis where possible.
    for (let i = 0; i < m; i++) {
      if (!isArt[basis[i]]) continue;
      for (let j = 0; j < N; j++) {
        if (!isArt[j] && Math.abs(T[i * W + j]) > 1e-9) { pivot(i, j); break; }
      }
    }
  }

  // Phase 2.
  const c2 = new Float64Array(N);
  for (let j = 0; j < n; j++) c2[j] = c[j];
  const allowed = new Uint8Array(N);
  for (let j = 0; j < N; j++) allowed[j] = isArt[j] ? 0 : 1;
  const st = run(c2, allowed);
  if (st !== 'optimal') return { status: st, iters };

  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i * W + N];
  let obj = 0;
  for (let j = 0; j < n; j++) obj += c[j] * x[j];
  return { status: 'optimal', x: Array.from(x), objective: obj, iters };
}
