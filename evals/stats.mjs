/**
 * Zero-dependency statistical inference & Monte Carlo primitives for Antigravity Booster (`agb`) benchmarks.
 * Provides deterministic seeded PRNG (`mulberry32`), parametric/non-parametric summaries,
 * percentile bootstrap confidence intervals, Mann-Whitney U test, Cohen's d,
 * two-proportion z-test, and Wilson score binomial confidence intervals.
 */

/** Deterministic 32-bit PRNG (Mulberry32) returning floats in [0, 1). */
export function mulberry32(seed = 20261030) {
  let state = seed >>> 0;
  return function nextFloat() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform for standard normal N(0, 1) variates. */
export function sampleNormal(rng, mu = 0, sigma = 1) {
  let u1 = 0;
  while (u1 <= 1e-12) u1 = rng();
  const u2 = rng();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mu + z0 * sigma;
}

/** Sample from a log-normal distribution parameterized by target median and log-scale sigma. */
export function sampleLogNormal(rng, targetMedian, sigma = 0.2, minFloor = 0.1) {
  const mu = Math.log(Math.max(targetMedian, 1e-6));
  return Math.max(minFloor, Math.exp(sampleNormal(rng, mu, sigma)));
}

/** Sample a Bernoulli trial with success probability p in [0, 1]. */
export function sampleBernoulli(rng, p) {
  return rng() < p ? 1 : 0;
}

export function mean(xs) {
  if (!xs.length) return 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

export function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sumSq = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    sumSq += d * d;
  }
  return sumSq / (xs.length - 1);
}

export function sd(xs) {
  return Math.sqrt(variance(xs));
}

export function quantile(xs, q) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function median(xs) {
  return quantile(xs, 0.5);
}

export function p90(xs) {
  return quantile(xs, 0.9);
}

export function p95(xs) {
  return quantile(xs, 0.95);
}

export function iqr(xs) {
  return quantile(xs, 0.75) - quantile(xs, 0.25);
}

/**
 * Abramowitz & Stegun 7.1.26 approximation of erf(x) (max error <= 1.5e-7)
 * used to compute exact two-sided normal p-values without external libraries.
 */
export function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Two-sided p-value from a standard normal z-statistic. */
export function normalTwoSidedPValue(z) {
  const absZ = Math.abs(z);
  const erfcVal = 1.0 - erf(absZ / Math.SQRT2);
  return Math.max(0, Math.min(1, erfcVal));
}

/** Format a p-value for scientific/engineering tables. */
export function formatPValue(p) {
  if (p < 0.0001) return '< 0.0001';
  return p.toFixed(4);
}

/** Non-parametric percentile bootstrap confidence interval. */
export function bootstrapCI(xs, { statFn = mean, resamples = 2000, alpha = 0.05, seed = 1337 } = {}) {
  if (!xs.length) return { point: 0, low: 0, high: 0 };
  const rng = mulberry32(seed);
  const n = xs.length;
  const stats = new Array(resamples);
  const sample = new Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) {
      sample[i] = xs[Math.floor(rng() * n)];
    }
    stats[b] = statFn(sample);
  }
  return {
    point: statFn(xs),
    low: quantile(stats, alpha / 2),
    high: quantile(stats, 1 - alpha / 2),
  };
}

/**
 * Paired ratio summary (e.g. speedup = baseline / treatment) with 95% bootstrap CI
 * over paired observations.
 */
export function pairedRatioSummary(baselineXs, treatmentXs, { resamples = 2000, alpha = 0.05, seed = 2026 } = {}) {
  const n = Math.min(baselineXs.length, treatmentXs.length);
  if (n === 0) return { ratioOfMeans: 1, medianPairwiseRatio: 1, ciLow: 1, ciHigh: 1 };
  const pairwise = new Array(n);
  for (let i = 0; i < n; i++) {
    pairwise[i] = baselineXs[i] / Math.max(1e-9, treatmentXs[i]);
  }
  const rng = mulberry32(seed);
  const ratios = new Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sumBase = 0;
    let sumTreat = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sumBase += baselineXs[idx];
      sumTreat += treatmentXs[idx];
    }
    ratios[b] = sumBase / Math.max(1e-9, sumTreat);
  }
  return {
    ratioOfMeans: mean(baselineXs) / Math.max(1e-9, mean(treatmentXs)),
    medianPairwiseRatio: median(pairwise),
    ciLow: quantile(ratios, alpha / 2),
    ciHigh: quantile(ratios, 1 - alpha / 2),
  };
}

/** Pooled-SD Cohen's d effect size between two continuous samples. */
export function cohensD(xs, ys) {
  if (xs.length < 2 || ys.length < 2) return 0;
  const nx = xs.length;
  const ny = ys.length;
  const vx = variance(xs);
  const vy = variance(ys);
  const pooledSd = Math.sqrt(((nx - 1) * vx + (ny - 1) * vy) / (nx + ny - 2));
  if (pooledSd === 0) return 0;
  return (mean(xs) - mean(ys)) / pooledSd;
}

/**
 * Two-sided Mann-Whitney U test with tie correction and rank-biserial effect size.
 */
export function mannWhitneyU(xs, ys) {
  const nx = xs.length;
  const ny = ys.length;
  if (nx === 0 || ny === 0) return { u: 0, z: 0, pValue: 1, rankBiserial: 0 };

  const combined = [
    ...xs.map((v) => ({ v, group: 0 })),
    ...ys.map((v) => ({ v, group: 1 })),
  ].sort((a, b) => a.v - b.v);

  const n = combined.length;
  let tieCorrectionSum = 0;
  let rankSumX = 0;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && combined[j].v === combined[i].v) j++;
    const tieCount = j - i;
    const avgRank = (i + 1 + j) / 2;
    if (tieCount > 1) {
      tieCorrectionSum += (tieCount ** 3) - tieCount;
    }
    for (let k = i; k < j; k++) {
      if (combined[k].group === 0) rankSumX += avgRank;
    }
    i = j;
  }

  const uX = rankSumX - (nx * (nx + 1)) / 2;
  const uY = nx * ny - uX;
  const u = Math.min(uX, uY);
  const muU = (nx * ny) / 2;
  const tieTerm = tieCorrectionSum / (n * (n - 1));
  const sigmaU = Math.sqrt(((nx * ny) / 12) * ((n + 1) - tieTerm));
  const z = sigmaU > 0 ? (uX - muU) / sigmaU : 0;
  const pValue = normalTwoSidedPValue(z);
  const rankBiserial = (2 * uX) / (nx * ny) - 1;
  return { u, uX, uY, z, pValue, rankBiserial };
}

/**
 * Wilson score 95% confidence interval for a binomial proportion k / n.
 */
export function wilsonScoreInterval(k, n, z = 1.959963984540054) {
  if (n <= 0) return { p: 0, low: 0, high: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    p,
    low: Math.max(0, center - halfWidth),
    high: Math.min(1, center + halfWidth),
  };
}

/**
 * Two-proportion z-test comparing event rate p1 = k1/n1 vs p2 = k2/n2.
 */
export function twoProportionZTest(k1, n1, k2, n2) {
  if (n1 <= 0 || n2 <= 0) {
    return { p1: 0, p2: 0, z: 0, pValue: 1, absDiff: 0, relativeReduction: 0 };
  }
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p1 - p2) / se : 0;
  const pValue = normalTwoSidedPValue(z);
  const absDiff = p1 - p2;
  const relativeReduction = p1 > 0 ? (p1 - p2) / p1 : 0;
  return {
    p1,
    p2,
    ci1: wilsonScoreInterval(k1, n1),
    ci2: wilsonScoreInterval(k2, n2),
    z,
    pValue,
    absDiff,
    relativeReduction,
  };
}

/** Summarize a continuous sample with parametric, non-parametric, and bootstrap CI metrics. */
export function summarizeContinuous(xs, { seed = 1337 } = {}) {
  const ci = bootstrapCI(xs, { statFn: mean, seed });
  return {
    n: xs.length,
    mean: mean(xs),
    sd: sd(xs),
    median: median(xs),
    p90: p90(xs),
    p95: p95(xs),
    iqr: iqr(xs),
    meanCi95: [ci.low, ci.high],
  };
}
