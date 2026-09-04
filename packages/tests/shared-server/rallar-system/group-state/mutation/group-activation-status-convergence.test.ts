import { describe, expect, it } from 'vitest';

import { computeUpdateGroupActivationStatus } from '@shared-server/rallar-system/group-state/mutation/aggregate/compute-update-group-activation-status.ts';
import type {
    GroupMutationCommand,
    GroupMutationRead
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toUpdateGroupActivationStatusCommand } from '@shared-server/rallar-system/group-state/to-update-group-activation-status-command.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { Group } from '@shared/api/group-types.ts';

import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import { createMutationFacts, createMutationRead } from '../group-state-concurrency-test-fixtures.ts';

const BASIS: GroupLayoutIdentity = { groupRevision: 4, presenceRevision: 2, version: 1, state: 'active' };
const FORMATION_EPOCH = 2;
const FIXTURE_GROUP = createMutationRead().group!.value;
const FIXTURE_GROUP_REF = {
    applicationId: FIXTURE_GROUP.applicationId,
    workspaceId: FIXTURE_GROUP.workspaceId,
    groupId: FIXTURE_GROUP.groupId
};

/**
 * Product decision 33's convergence rule, proved where the race is
 * expressible. A black-box recipe cannot stage it: the watermark drop is only
 * observable when a reading fails to advance the stored evidence, which in a
 * single-threaded recipe is exactly when the status is unchanged anyway, so
 * the same-status no-op would satisfy the assertion whether or not the rule
 * exists (I42). Here the loser's evidence is older *and* would change the
 * band, so only the watermark rule can stop it.
 */
describe('two status writers converge on the newest evidence', () => {
    it('drops a write whose evidence the stored status already dominates', () => {
        const computed = computeUpdateGroupActivationStatus(
            staleCommand(),
            readWithStoredStatus(storedStatus({ version: 9, createdAtEpochMs: 9_000 })),
            createMutationFacts()
        );

        expect(computed.outcome).toBe('no-op');
    });

    it('writes when the same reading carries newer evidence', () => {
        const computed = computeUpdateGroupActivationStatus(
            staleCommand({ evidenceWatermark: { version: 11, createdAtEpochMs: 11_000 } }),
            readWithStoredStatus(storedStatus({ version: 9, createdAtEpochMs: 9_000 })),
            createMutationFacts()
        );

        expect(computed.outcome).toBe('write');
    });

    // A changed basis starts a distinct causal series, so watermarks from the
    // old one cannot order writes in the new one.
    it('does not compare watermarks across a changed basis', () => {
        const otherBasis = { ...BASIS, version: 2 };
        const computed = computeUpdateGroupActivationStatus(
            staleCommand(),
            readWithStoredStatus({
                ...storedStatus({ version: 9, createdAtEpochMs: 9_000 }),
                coverageBasisLayoutIdentity: otherBasis
            }),
            createMutationFacts()
        );

        expect(computed.outcome).toBe('write');
    });

    // The durable clocks observe an absence of evidence, so they carry no
    // watermark and must never be dropped by a rule about advancing one.
    it('never drops a clock write, which carries no watermark', () => {
        const computed = computeUpdateGroupActivationStatus(
            staleCommand({ evidenceWatermark: null, dwell: { satisfied: true, dueAtEpochMs: 5_000 } }),
            readWithStoredStatus(storedStatus({ version: 9, createdAtEpochMs: 9_000 })),
            createMutationFacts()
        );

        expect(computed.outcome).toBe('write');
    });
});

function staleCommand(
    overrides: Partial<Parameters<typeof toUpdateGroupActivationStatusCommand>[0]> = {}
): Extract<GroupMutationCommand, { operation: 'updateGroupActivationStatus'; }> {
    return toUpdateGroupActivationStatusCommand({
        groupRef: FIXTURE_GROUP_REF,
        formationEpoch: FORMATION_EPOCH,
        coverageBasisLayoutIdentity: BASIS,
        // Far below the success rate, so an applied write would change the
        // band -- which is what makes the drop observable at all.
        coverageRate: 0.1,
        evidenceWatermark: { version: 3, createdAtEpochMs: 3_000 },
        dwell: null,
        ...overrides
    }) as Extract<GroupMutationCommand, { operation: 'updateGroupActivationStatus'; }>;
}

function storedStatus(evidenceWatermark: { version: number; createdAtEpochMs: number; }): GroupActivationStatus {
    return {
        condition: 'active',
        coverageRate: 1,
        coverageBasisLayoutIdentity: BASIS,
        formationEpoch: FORMATION_EPOCH,
        evidenceWatermark,
        publishedAtEpochMs: 1_500
    };
}

function readWithStoredStatus(activationStatus: GroupActivationStatus): GroupMutationRead {
    const base = createMutationRead();
    const stored = base.group!;
    const group: Group = {
        ...stored.value,
        lifecycleState: 'active',
        formationEpoch: FORMATION_EPOCH,
        acceptedLayoutIdentity: BASIS,
        activationStatus
    };
    return {
        ...base,
        group: { ...stored, value: group },
        // `managed` carries real rates (0.95 / 0.5); the default preset's are
        // both zero, which would read every coverage as `active`.
        lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset('managed') }
    };
}
