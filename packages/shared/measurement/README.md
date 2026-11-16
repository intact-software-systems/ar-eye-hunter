# Measurement

Import the owning module directly. This folder has no local barrel; it holds the four measurement primitives that
runtime code, the harness and the reports share, so that no feature carries its own copy (D642, D650).

| Owner                                                            | What it answers                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [computeNearestRank](compute-nearest-rank.ts)                    | The nearest-rank percentile of a list of values.                                                                               |
| [computeNumberExtrema](compute-number-extrema.ts)                | The smallest and the largest of a list of values, absent for no values.                                                        |
| [BoundedHistogram](bounded-histogram.ts)                         | A fixed-bound histogram of non-negative numbers: its creation, one more sample, and the decoding of one read from outside.     |
| [computeSameRegimeComparison](compute-same-regime-comparison.ts) | Whether two runs measured under the same regime differ in a figure by more than a declared band, or cannot be compared at all. |

## Nearest rank

`computeNearestRank(values, fraction)` returns the value at rank `ceil(fraction * n)` of the ascending values. A
fraction at or below 0 reads the smallest value and a fraction at or above 1 the largest. It has two edge answers:
no values, and a fraction that is not finite, both return `undefined`. Each caller states its own answer for no
samples (a zero, an omitted figure, a refusal); the primitive does not choose one (D650).

## Bounded histogram

A `BoundedHistogram` holds `upperBounds` (1 to `MAX_BOUNDED_HISTOGRAM_BOUNDS`, 32, finite, at least 0, strictly
ascending), one more `bucketCounts` entry than bounds, `count`, `sum`, and `min` and `max` (`null` while the count is 0).
A sample lands in the first bucket whose bound it does not exceed; a sample above the last bound lands in the final
overflow bucket. `createBoundedHistogram` and `computeBoundedHistogramAfter` return an `Either`: a sample that is not a
finite number of at least 0 is refused as a value, never clamped and never thrown, and the caller counts the refusal.
`decodeBoundedHistogram` reads a histogram from `unknown` and names every field that is wrong, including a bucket total
that differs from `count`. There is no quantile reader and no merge; the first reader that needs one adds it.

## Same-regime comparison

`computeSameRegimeComparison({ baseline, candidate, band })` compares two runs, each a `regime` record and a set of
named `figures`, under a `band` of a relative and an absolute allowance. It refuses with one of three kinds, checked in
this order: `different-regime` (the keys name every regime field that differs or is on one side only),
`different-figures` (a figure only one run reports) and `non-finite-figures`. Otherwise every figure reads `noise`,
`regression` or `improvement`; every figure is lower-is-better. A difference is noise when it is at most the larger of
the absolute allowance and the relative allowance of the baseline value, so a difference exactly at the band's edge is
noise. The caller declares the band before it runs; a run outside it is investigated, not answered by widening it
(D652).

## Not here

The nearest-rank copies in the four `.mjs` scripts and the interpolating medians (two middle values averaged) in five
TypeScript files are not folded; both are listed in `plans/backlog.md`.
