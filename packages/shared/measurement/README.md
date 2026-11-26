# Measurement

Import the owning module directly. This folder has no local barrel; it holds the five measurement primitives that
runtime code, the harness and the reports share, so that no feature carries its own copy (D642, D650).

| Owner                                                                    | What it answers                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [computeNearestRank](compute-nearest-rank.ts)                            | The nearest-rank percentile of a list of values.                                                                                             |
| [computeNumberExtrema](compute-number-extrema.ts)                        | The smallest and the largest of a list of values, absent for no values.                                                                      |
| [BoundedHistogram](bounded-histogram.ts)                                 | A fixed-bound histogram of non-negative numbers: its creation, one more sample or a list of them, and the decoding of one read from outside. |
| [computeBoundedHistogramQuantile](compute-bounded-histogram-quantile.ts) | The bucket that holds the nearest-rank sample of a bounded histogram, narrowed by its smallest and largest sample.                           |
| [computeSameRegimeComparison](compute-same-regime-comparison.ts)         | Whether two sides of runs measured under the same regime differ in a figure by more than a declared band, or cannot be compared at all.      |

## Nearest rank

`computeNearestRank(values, fraction)` returns the value at rank `ceil(fraction * n)` of the ascending values. A
fraction at or below 0 reads the smallest value and a fraction at or above 1 the largest. It has two edge answers:
no values, and a fraction that is not finite, both return `undefined`. Each caller states its own answer for no
samples (a zero, an omitted figure, a refusal); the primitive does not choose one (D650).
`computeNearestRankIndex(count, fraction)` is the place of that rank among `count` ascending values, counted from 0,
with the same two edge answers: the one rank rule for a reader that holds a count and no list of values.

## Bounded histogram

A `BoundedHistogram` holds `upperBounds` (1 to `MAX_BOUNDED_HISTOGRAM_BOUNDS`, 32, finite, at least 0, strictly
ascending), one more `bucketCounts` entry than bounds, `count`, `sum`, and `min` and `max` (`null` while the count is 0).
A sample lands in the first bucket whose bound it does not exceed; a sample above the last bound lands in the final
overflow bucket. `createBoundedHistogram` and `computeBoundedHistogramAfter` return an `Either`: a sample that is not a
finite number of at least 0 is refused as a value, never clamped and never thrown, and the caller counts the refusal.
`computeBoundedHistogramRecorded(histogram, values)` is that count for a list: it records each value in order and
returns the histogram beside `unrecordedSamples`, the number of values it refused. The publication figures and the
harness's `messages.received` sample age both record through it.
`decodeBoundedHistogram` reads a histogram from `unknown` and names every field that is wrong, including a bucket total
that differs from `count`. `decodeBoundedHistogramOnBounds` also refuses a histogram on other bounds than the ones its
owner declares, so two reads stay comparable bucket by bucket. [assertBoundedHistogram](assert-bounded-histogram.ts)
creates the empty histogram of a declared set of bounds and throws on a set that is not valid, a programmer's error.
There is no merge; the first reader that needs one adds it.

## Bounded histogram quantile

A histogram keeps no sample, so it cannot state a percentile as one value.
`computeBoundedHistogramQuantile(histogram, fraction)` returns `{ atLeast, atMost }`, both ends included: the bucket
that holds the sample at the rank `computeNearestRankIndex` reads, narrowed by the histogram's `min` and `max`. The
nearest-rank value of the samples the histogram recorded always lies in that range. `atLeast` is the bound under the
bucket, which the sample itself exceeds, or `min` where that is higher, so the first bucket starts at `min`; `atMost`
is the bucket's own bound, or `max` where that is lower, so the overflow bucket ends at `max` and a histogram of one
sample reads as that sample. A sample exactly on a bound is read in the bucket that bound closes, as it was recorded.
The fraction has the edge answers of `computeNearestRank`: at or below 0 it reads the bucket of the smallest sample, at
or above 1 that of the largest, and a fraction that is not finite returns `undefined`, as does a histogram with no
sample; neither is an error. A histogram whose buckets count fewer samples than its `count`, which neither creation
nor decoding produces, throws: a programmer's error.

## Same-regime comparison

`computeSameRegimeComparison({ baseline, candidate, band, minimumRunsPerSide })` compares two sides, each a list of
runs, a run being the instant it was taken (`takenAtEpochMs`), a `regime` record and a set of named `figures`, under a
`band` of a relative and an absolute allowance. A side's figure is the median of its runs' values by
`computeNearestRank`, the lower middle run of an even number, never an interpolated value; every run's value is reported
beside it (`baselineRuns`, `candidateRuns`, in the order each side lists them). The runs are taken baseline first, then
alternating between the sides, so a baseline side may hold one run more; only `takenAtEpochMs` decides the order, not a
run's place in its side's list. It refuses with one of six kinds, checked in this order: `too-few-runs` (the keys name
each side with no run or fewer than `minimumRunsPerSide`), `unordered-runs` (a run taken at no finite instant, or at
the same instant as another run of either side; the keys name each side that holds one), `sides-not-alternating` (the
runs in the order taken do not alternate baseline first; the keys name the side of every run in that order),
`different-regime` (the keys name every regime field that any run differs in or lacks), `different-figures` (a figure
not every run reports) and `non-finite-figures`. Otherwise every figure reads `noise`,
`regression` or `improvement`; every figure is lower-is-better. A difference is noise when it is at most the larger of
the absolute allowance and the relative allowance of the baseline value, so a difference exactly at the band's edge is
noise. The caller declares the band and the number of runs before it runs; a result outside the band is investigated,
not answered by widening it (D652, D664).

## Not here

The nearest-rank copies in the four `.mjs` scripts and the interpolating medians (two middle values averaged) in five
TypeScript files are not folded; both are listed in `plans/backlog.md`.
