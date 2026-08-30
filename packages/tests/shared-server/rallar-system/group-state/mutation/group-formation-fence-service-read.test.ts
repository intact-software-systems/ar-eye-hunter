import { describe, expect, it } from 'vitest';

import { toFormationActivateCommand, toFormationRetryPlanCommand } from '@shared-server/rallar-system/group-state/group-formation-mutation-command.ts';
import type { GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/persistence/rtc-topology-errors.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

const SCOPE = { applicationId: 'fence-read-app', workspaceId: 'fence-read-workspace' } as const;
const GROUP_REF: GroupRef = { ...SCOPE, groupId: 'fence-read-group' };

const PLANNED_LAYOUT: GroupLayoutIdentity = {
    groupRevision: 3,
    presenceRevision: 5,
    version: 2,
    state: 'active'
};

const SUPERSEDING_LAYOUT: GroupLayoutIdentity = { ...PLANNED_LAYOUT, groupRevision: 4, version: 3 };

const PLANNED_SNAPSHOT: RallarOverlayTopologySnapshot = {
    groupRef: GROUP_REF,
    overlayId: toScopedOverlayId(GROUP_REF),
    name: 'fence-read-overlay',
    topology: 'tree',
    degreeLimit: 2,
    version: PLANNED_LAYOUT.version,
    state: 'active',
    sourceGroupStateCausalRevision: {
        groupRevision: PLANNED_LAYOUT.groupRevision,
        presenceRevision: PLANNED_LAYOUT.presenceRevision
    },
    activeSessionIds: [],
    nextHopsBySessionId: {},
    createdByClientId: 'fence-read-service',
    createdAtEpochMs: 800,
    updatedAtEpochMs: 900
};

// The one place the whole fence read chain runs against the durable service:
// the gate in service.read, the reader invocation, the attached identity, and
// compute consuming exactly what the service read — not a hand-built fixture.
interface FenceReadHarnessOptions {
    readonly readAcceptedLayoutRow?: (ref: GroupRef) => Promise<null>;
}

async function createFenceReadHarness(options: FenceReadHarnessOptions = {}) {
    const readRefs: GroupRef[] = [];
    const acceptedReadRefs: GroupRef[] = [];
    const service = createTestGroupStateService({
        runtimeRepository: new FakeRuntimeStateRepository(),
        now: () => 1_000,
        randomId: (() => {
            let generated = 0;
            return () => `fence-read-id-${++generated}`;
        })(),
        serviceId: 'fence-read-service',
        readPlannedLayoutRow: (ref) => {
            readRefs.push(ref);
            return Promise.resolve({ snapshot: PLANNED_SNAPSHOT, revision: 7 });
        },
        readAcceptedLayoutRow: async (ref) => {
            acceptedReadRefs.push(ref);
            return await (options.readAcceptedLayoutRow?.(ref) ?? Promise.resolve(null));
        }
    });
    await service.createGroup(SCOPE, {
        groupId: GROUP_REF.groupId,
        displayName: 'Fence read group',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'owner',
        requestId: 'fence-read-seed'
    });
    const prepare = async (command: GroupMutationCommand): Promise<GroupStateMutationCommand> => {
        const preparation = command.operation === 'planGroupLayout'
            ? await service.prepareFormationAutomationMutation(command, 1_000)
            : await service.prepareFormationCriterionMutation(command, 1_000);
        return {
            authorityProof: null,
            descriptor: null,
            command: preparation.command,
            facts: { ...preparation.facts, attemptCount: 1 }
        };
    };
    return { service, readRefs, acceptedReadRefs, prepare };
}

describe('formation fence through the durable service read', () => {
    it('reads and attaches the stored planned identity for a layout-fenced command', async () => {
        const { service, readRefs, prepare } = await createFenceReadHarness();
        const prepared = await prepare(toFormationActivateCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: PLANNED_LAYOUT
        }));

        const read = await service.read(prepared);

        expect(readRefs).toEqual([GROUP_REF]);
        expect(read.plannedLayoutRow?.snapshot).toEqual(PLANNED_SNAPSHOT);
    });

    it('never invokes the reader for a automatic plan command without a layout fence', async () => {
        const { service, readRefs, prepare } = await createFenceReadHarness();
        const prepared = await prepare(
            toFormationRetryPlanCommand({ groupRef: GROUP_REF, formationEpoch: 0 })
        );

        const read = await service.read(prepared);

        expect(readRefs).toEqual([]);
        expect(read.plannedLayoutRow).toBeNull();
    });

    it('propagates an accepted-layout corruption from activation without computing', async () => {
        const corruption = new RtcTopologyRepositoryInvariantCorruptionError(
            'accepted-layout-key',
            'Stored topology snapshot is malformed'
        );
        const { service, acceptedReadRefs, prepare } = await createFenceReadHarness({
            readAcceptedLayoutRow: async () => {
                throw corruption;
            }
        });
        const prepared = await prepare(toFormationActivateCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: PLANNED_LAYOUT
        }));

        await expect(service.read(prepared)).rejects.toBe(corruption);
        expect(acceptedReadRefs).toEqual([GROUP_REF]);
    });

    it('feeds compute the service-read identity: superseded fences reject, matches pass', async () => {
        const { service, prepare } = await createFenceReadHarness();
        const superseded = await prepare(toFormationActivateCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: SUPERSEDING_LAYOUT
        }));
        const supersededComputed = service.compute(superseded, await service.read(superseded));
        if (!('receipt' in supersededComputed) || supersededComputed.receipt.rejection === null) {
            throw new Error('Superseded fence must compute a rejection receipt');
        }
        expect(supersededComputed.receipt.rejection).toContain('planned-layout-superseded');

        const matching = await prepare(toFormationActivateCommand({
            groupRef: GROUP_REF,
            formationEpoch: 0,
            observedRate: 0.95,
            degraded: false,
            expectedLayout: PLANNED_LAYOUT
        }));
        const read = await service.read(matching);
        // A matching fence passes through to the state machine, which denies
        // activation from the seeded stage — proving the fence consumed and
        // accepted the identity the service read, not a fixture.
        expect(() => service.compute(matching, read)).toThrow(GroupPolicyDeniedError);
    });
});
