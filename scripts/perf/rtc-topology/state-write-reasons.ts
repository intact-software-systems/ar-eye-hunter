import type {
  StateWriteBenchmarkRegressionReason,
} from '../state-write/api-v1-state-write-benchmark-artifact.ts';

const DURABLE_APPEND_RESOURCE_REASON =
  'Atomic RTC topology publication now executes one durable per-process stream ' +
  'HEAD CAS and log append CTE inside the accepted or loaded work transaction.';

export const STATE_WRITE_REASONS = (
  ['uncontended', 'shared', 'hot'] as const
).flatMap((workload) =>
  [
    'sql.statements',
    'sql.rowsRead',
    'sql.serializedResultBytes',
    'postgres.transactionDurationMs',
  ].map((metric) => ({
    workload,
    metric,
    reason: DURABLE_APPEND_RESOURCE_REASON,
  }))
);

export const RTC_TOPOLOGY_REGRESSION_REASON_PROFILE = 'rtc-topology-durable-append' as const;

export function selectStateWriteRegressionReasons(
  profile: string | undefined,
  precommittedReasons: readonly StateWriteBenchmarkRegressionReason[],
): readonly StateWriteBenchmarkRegressionReason[] {
  if (profile === undefined) return precommittedReasons;
  if (
    profile !== RTC_TOPOLOGY_REGRESSION_REASON_PROFILE ||
    precommittedReasons.length > 0
  ) {
    throw new Error('State-write regression reason selection is inconsistent');
  }
  return STATE_WRITE_REASONS;
}
