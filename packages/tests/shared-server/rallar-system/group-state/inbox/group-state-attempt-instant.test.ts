import { describe, expect, it } from 'vitest';

import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { decodeFormationTimerWork } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type {
    AuthenticatedGroupMutationEnqueue,
    GroupConnectAppInboxPayload,
    GroupCreateAppInboxPayload,
    GroupDirectorAppointAppInboxPayload,
    GroupLifecycleTransitionAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { connectPlannedSnapshot } from './group-state-inbox-planned-layout-fixtures.ts';
import { presenceConnectEnqueue } from './group-state-inbox-presence-fixtures.ts';
import { createAuthorityHarness, processAuthenticated, SCOPE, type AuthorityHarness } from './group-state-inbox-test-runtime.ts';

/** How far the lane's clock runs ahead of the enqueue-time capture, as a lane backlog would put it. */
const LANE_WAIT_MS = 7_000;
const OWNER_ACTOR = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' } as const;
/** The `managed` preset's formation deadline: a phased group whose establishment the deadline bounds. */
const DEADLINE_MS = 30_000;
const PLANNED_IDENTITY = { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' as const };

describe('group mutation attempt instant', () => {
    it('starts a connect\'s establishment window and deadline at the lane\'s attempt, not at enqueue', async () => {
        const groupId = 'attempt-instant-connect-room';
        const runtimeRepository = new FakeRuntimeStateRepository();
        const plannedSnapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await plannedSnapshots.commitSnapshot({ candidate: connectPlannedSnapshot(groupId, PLANNED_IDENTITY) });
        const harness = await createLaneDelayedHarness({
            runtimeRepository,
            readPlannedLayoutRow: async (ref) => {
                const entry = await plannedSnapshots.findSnapshotEntry(ref);
                return entry ? { snapshot: entry.value, revision: entry.entry.revision } : null;
            }
        });
        await processAsOwner(harness, createPhasedGroupEnqueue(groupId));
        await processAsOwner(harness, planEnqueue(groupId));
        const planned = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
        const timersBefore = new Set(harness.database.outboxEntries.keys());

        const connected = await processAsOwner(harness, connectEnqueue(groupId, planned?.formationEpoch ?? 0));

        expect(connected.left).toBeUndefined();
        const laneAtEpochMs = harness.nowEpochMs + LANE_WAIT_MS;
        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
        expect(group?.lifecycleState).toBe('connecting');
        expect(group?.establishmentStartedAtEpochMs).toBe(laneAtEpochMs);
        const deadlines = [...harness.database.outboxEntries]
            .filter(([key]) => !timersBefore.has(key))
            .map(([, entry]) => decodeFormationTimerWorkOrNull(entry.resource))
            .filter((work) => work?.kind === 'deadline');
        expect(deadlines.map((work) => work?.notBeforeEpochMs)).toEqual([laneAtEpochMs + DEADLINE_MS]);
    });

    it('dates a director appointment at the lane\'s attempt, not at enqueue', async () => {
        const groupId = 'attempt-instant-director-room';
        const harness = await createLaneDelayedHarness({});
        await processAsOwner(harness, createPhasedGroupEnqueue(groupId));
        await processAsOwner(harness, presenceConnectEnqueue(groupId, 'owner', harness.nowEpochMs));

        const appointed = await processAsOwner(harness, directorAppointEnqueue(groupId));

        expect(appointed.left?.message).toBeUndefined();
        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
        expect(readRallarGroupDirectorAppointment(group?.metadata)?.appointedAtEpochMs).toBe(
            harness.nowEpochMs + LANE_WAIT_MS
        );
    });
});

type LaneDelayedHarnessOptions = Parameters<typeof createAuthorityHarness>[1];

/** The enqueue captures at the harness clock; the lane samples its attempt LANE_WAIT_MS later. */
async function createLaneDelayedHarness(options: NonNullable<LaneDelayedHarnessOptions>): Promise<AuthorityHarness> {
    let laneAtEpochMs = Number.NaN;
    const harness = await createAuthorityHarness(['owner'], {
        ...options,
        serviceOptions: { nowEpochMs: () => laneAtEpochMs }
    });
    laneAtEpochMs = harness.nowEpochMs + LANE_WAIT_MS;
    return harness;
}

async function processAsOwner(harness: AuthorityHarness, input: AuthenticatedGroupMutationEnqueue) {
    const result = await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: harness.sessions.owner,
        input
    });
    expect(result.left?.message, input.type).toBeUndefined();
    return result;
}

function toEnqueue<Type extends AuthenticatedGroupMutationEnqueue['type']>(
    type: Type,
    groupId: string,
    data: Extract<AuthenticatedGroupMutationEnqueue, { type: Type; }>['data']
): AuthenticatedGroupMutationEnqueue {
    const requestId = `${groupId}-${type.toLowerCase()}`;
    return {
        type,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: 'owner',
        data
    } as AuthenticatedGroupMutationEnqueue;
}

function createPhasedGroupEnqueue(groupId: string): AuthenticatedGroupMutationEnqueue {
    return toEnqueue(
        AppInboxType.GROUP_CREATE,
        groupId,
        {
            scope: SCOPE,
            request: {
                groupId,
                displayName: groupId,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                lifecyclePolicy: { preset: 'managed' },
                ...OWNER_ACTOR,
                requestId: `${groupId}-group_create`
            }
        } satisfies GroupCreateAppInboxPayload
    );
}

function planEnqueue(groupId: string): AuthenticatedGroupMutationEnqueue {
    return toEnqueue(
        AppInboxType.GROUP_PLAN,
        groupId,
        {
            scope: SCOPE,
            groupId,
            request: { ...OWNER_ACTOR, requestId: `${groupId}-group_plan` }
        } satisfies GroupLifecycleTransitionAppInboxPayload
    );
}

function connectEnqueue(groupId: string, expectedFormationEpoch: number): AuthenticatedGroupMutationEnqueue {
    return toEnqueue(
        AppInboxType.GROUP_CONNECT,
        groupId,
        {
            scope: SCOPE,
            groupId,
            request: {
                ...OWNER_ACTOR,
                requestId: `${groupId}-group_connect`,
                expectedFormationEpoch,
                expectedLayout: PLANNED_IDENTITY
            }
        } satisfies GroupConnectAppInboxPayload
    );
}

function directorAppointEnqueue(groupId: string): AuthenticatedGroupMutationEnqueue {
    return toEnqueue(
        AppInboxType.GROUP_DIRECTOR_APPOINT,
        groupId,
        {
            scope: SCOPE,
            groupId,
            request: { ...OWNER_ACTOR, requestId: `${groupId}-group_director_appoint` }
        } satisfies GroupDirectorAppointAppInboxPayload
    );
}

function decodeFormationTimerWorkOrNull(resource: string) {
    try {
        return decodeFormationTimerWork(resource);
    }
    catch {
        return null;
    }
}
