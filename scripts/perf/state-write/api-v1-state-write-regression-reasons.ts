import type { StateWriteBenchmarkRegressionReason } from './api-v1-state-write-benchmark-artifact.ts';

const DURABLE_APPEND_RESOURCE_REASON = 'Atomic RTC topology publication now executes one durable per-process stream ' +
    'HEAD CAS and log append CTE inside the accepted or loaded work transaction.';

export const STATE_WRITE_REASONS = (['uncontended', 'shared', 'hot'] as const).flatMap((workload) =>
    [
        'sql.statements',
        'sql.rowsRead',
        'sql.serializedResultBytes',
        'postgres.transactionDurationMs'
    ].map((metric) => ({
        workload,
        metric,
        reason: DURABLE_APPEND_RESOURCE_REASON
    }))
);

const GROUP_FORMATION_DAMPING_REASON = 'Damped group formation reads the coalesced group-revision predecessor and ' +
    'performs its generation CAS inside each transition expansion, and every ' +
    'accepted topology plan writes its input fingerprint row; heartbeat lease ' +
    'renewals stop writing expansion outbox rows in exchange, which removes the ' +
    'per-minute idle storm measured by the formation-burst tiers.';

export const GROUP_FORMATION_DAMPING_REASONS = (['uncontended', 'shared', 'hot'] as const).flatMap(
    (workload) =>
        [
            'sql.statements',
            'sql.rowsRead',
            'sql.serializedResultBytes',
            'postgres.transactionDurationMs'
        ].map((metric) => ({
            workload,
            metric,
            reason: GROUP_FORMATION_DAMPING_REASON
        }))
);

export const RTC_TOPOLOGY_REGRESSION_REASON_PROFILE = 'rtc-topology-durable-append' as const;

export const GROUP_FORMATION_DAMPING_REGRESSION_REASON_PROFILE = 'group-formation-damping' as const;

const PLANNED_LAYOUT_PROMOTION_REASON = 'Slices 2 and 4a widen every persisted group row by two required fields ' +
    '(acceptedLayoutIdentity, transportState), growing serialized bytes and ' +
    'row work on all group writes; the measured counter deltas overlap the ' +
    'documented contention drift and the bench executes no promotions (its ' +
    'harness wires no topology outbox consumer and its mix issues no ' +
    'lifecycle operations), so the residue is row width plus drift, not ' +
    'promotion execution.';

export const PLANNED_LAYOUT_PROMOTION_REASONS = (['uncontended', 'shared', 'hot'] as const).flatMap(
    (workload) =>
        [
            'sql.statements',
            'sql.rowsRead',
            'sql.serializedResultBytes',
            'postgres.transactionDurationMs'
        ].map((metric) => ({
            workload,
            metric,
            reason: PLANNED_LAYOUT_PROMOTION_REASON
        }))
);

export const PLANNED_LAYOUT_PROMOTION_REGRESSION_REASON_PROFILE = 'planned-layout-promotion' as const;

export function selectStateWriteRegressionReasons(
    profile: string | undefined,
    precommittedReasons: readonly StateWriteBenchmarkRegressionReason[]
): readonly StateWriteBenchmarkRegressionReason[] {
    if (profile === undefined) {
        return precommittedReasons;
    }
    if (precommittedReasons.length > 0) {
        throw new Error('State-write regression reason selection is inconsistent');
    }
    if (profile === RTC_TOPOLOGY_REGRESSION_REASON_PROFILE) {
        return STATE_WRITE_REASONS;
    }
    if (profile === GROUP_FORMATION_DAMPING_REGRESSION_REASON_PROFILE) {
        return GROUP_FORMATION_DAMPING_REASONS;
    }
    if (profile === PLANNED_LAYOUT_PROMOTION_REGRESSION_REASON_PROFILE) {
        return PLANNED_LAYOUT_PROMOTION_REASONS;
    }
    throw new Error('State-write regression reason selection is inconsistent');
}
