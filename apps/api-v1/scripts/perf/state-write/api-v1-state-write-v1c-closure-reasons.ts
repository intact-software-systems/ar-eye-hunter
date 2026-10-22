import type { StateWriteBenchmarkRegressionReason } from './api-v1-state-write-benchmark-artifact.ts';

const V1C_CLOSURE_ROWS_READ_REASON = '#691 returns the runtime-state batch read as one row per entry instead of one ' +
    'aggregated row (entries materialised per attempt 95.1 → 100.1 in hot, bytes per attempt ' +
    '150k → 147k; shared 24.3 → 24.4 entries, 51k → 38k bytes) and the coalesced ' +
    'completion poll reads the waiting statuses in one statement; the selectors did not widen and ' +
    'statements fell about 25 %.';

export const V1C_CLOSURE_ROWS_READ_REASONS: readonly StateWriteBenchmarkRegressionReason[] =
    (['shared', 'hot'] as const).map((workload) => ({
        workload,
        metric: 'sql.rowsRead',
        reason: V1C_CLOSURE_ROWS_READ_REASON
    }));

export const V1C_CLOSURE_ROWS_READ_REGRESSION_REASON_PROFILE = 'v1c-closure-rows-read' as const;
