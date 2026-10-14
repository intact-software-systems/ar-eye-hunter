# Performance Report Formats

Read the format that matches the completed phase. Leave the other formats unread.

## Contents

- [Static audit](#static-audit)
- [Runtime validation](#runtime-validation)
- [Optimization result](#optimization-result)

## Static audit

```md
# Performance audit

## Executive summary

- Top 5 risks, ranked by expected impact and confidence.

## Hot path map

- Entry point -> critical flow -> likely expensive modules.

## Findings

| Severity | Confidence       | Category               | Location            | Why costly | Complexity/memory impact | Validation | Suggested fix |
| -------- | ---------------- | ---------------------- | ------------------- | ---------- | ------------------------ | ---------- | ------------- |
| High     | Strong suspicion | Algorithmic complexity | `path/file.ext:123` | ...        | ...                      | ...        | ...           |

## False-positive risks

- Findings that may be harmless depending on workload.

## Measurement plan

- Benchmarks, profilers, fixtures, and instrumentation needed next.

## Do first

1. Highest-impact next action.
2. Second action.
3. Third action.
```

## Runtime validation

```md
# Runtime performance validation

## Environment

- Branch/commit:
- Hardware/container notes:
- Runtime versions:
- Config:
- Input sizes:

## Commands run

    # exact commands

## Results

| Hypothesis | Result | Evidence | Confirmed/refuted/inconclusive | Notes |
| ---------- | ------ | -------- | ------------------------------ | ----- |

## CPU profile interpretation

- Hot functions, call paths, and likely causes.

## Memory profile interpretation

- Allocation sites, retained memory, peak heap/RSS, GC pressure.

## Leak findings

- Evidence for or against leak-like growth over repeated/long-running workloads.

## Recommendations

| Rank | Fix | Expected impact | Confidence | Risk | Validation |
| ---- | --- | --------------- | ---------- | ---- | ---------- |

## Next step

- One small, safe optimization to attempt first.
```

## Optimization result

```md
# Performance optimization result

## Change summary

- What changed and why.

## Files changed

- `path/file.ext`

## Correctness validation

- Tests run and results.

## Performance validation

| Metric | Before | After | Delta | Notes |
| ------ | ------ | ----- | ----- | ----- |

## Remaining risks

- Correctness, compatibility, measurement, or workload caveats.

## Follow-up opportunities

- Additional fixes that should be separate changes.
```
