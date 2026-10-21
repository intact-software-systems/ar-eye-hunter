import { describe, expect, it } from 'vitest';

import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { decodeFormationTimerWork } from '@shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts';
import type {
    AuthenticatedGroupMutationEnqueue,
    GroupConnectAppInboxPayload,
    GroupCreateAppInboxPayload,
    GroupDirectorAppointAppInboxPayload,
    GroupLifecycleTransitionAppInboxPayload,
    GroupUpdateAppInboxPayload
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { connectPlannedSnapshot } from './group-state-inbox-planned-layout-fixtures.ts';
import { presenceConnectEnqueue } from './group-state-inbox-presence-fixtures.ts';
import { createAuthorityHarness, processAuthenticated, SCOPE, type AuthorityHarness } from './group-state-inbox-test-runtime.ts';

/** How far the lane's clock runs ahead of the enqueue-time capture, as a lane backlog would put it. */
const LANE_WAIT_MS = 7_000;
const OWNER_ACTOR = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' } as const;
/** How long the harness's sessions live past the enqueue instant. */
const SESSION_LIFETIME_MS = 60_000;
/** The `managed` preset's formation deadline: a phased group whose establishment the deadline bounds. */
const DEADLINE_MS = 30_000;
const PLANNED_IDENTITY = { groupRevision: 1, presenceRevision: 0, version: 1, state: 'active' as const };

describe('group mutation attempt instant', () => {
    it('starts a connect\'s establishment window and deadline at the lane\'s attempt, not at enqueue', async () => {
        const groupId = 'attempt-instant-connect-room';
        const harness = await createPlannedGroupHarness(groupId);
        const timersBefore = new Set(harness.database.outboxEntries.keys());

        await processAsOwner(harness, connectEnqueue(groupId, await readFormationEpoch(harness, groupId)));

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

    it('commits a connect whose lane clock lags the enqueuing server, its window starting at the enqueue instant', async () => {
        const groupId = 'attempt-instant-lagging-room';
        const harness = await createPlannedGroupHarness(groupId);
        harness.setLaneWaitMs(-250);

        await processAsOwner(harness, connectEnqueue(groupId, await readFormationEpoch(harness, groupId)));

        const group = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group;
        expect(group?.lifecycleState).toBe('connecting');
        expect(group?.establishmentStartedAtEpochMs).toBe(harness.nowEpochMs);
    });

    it('refuses a command for a group that expired while the command was queued', async () => {
        const groupId = 'attempt-instant-expiring-room';
        const harness = await createLaneDelayedHarness({});
        harness.setLaneWaitMs(0);
        await processAsOwner(harness, createPhasedGroupEnqueue(groupId, harness.nowEpochMs + 3_000));
        harness.setLaneWaitMs(LANE_WAIT_MS);

        const updated = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: toEnqueue(
                AppInboxType.GROUP_UPDATE,
                groupId,
                {
                    scope: SCOPE,
                    groupId,
                    request: { displayName: 'Too late', ...OWNER_ACTOR, requestId: `${groupId}-group_update` }
                } satisfies GroupUpdateAppInboxPayload
            )
        });

        expect(updated.left).toMatchObject({ code: 'group-not-active' });
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName).toBe(groupId);
    });

    it('refuses a command whose session expired while the command was queued', async () => {
        const groupId = 'attempt-instant-session-room';
        const harness = await createLaneDelayedHarness({});
        harness.setLaneWaitMs(0);
        await processAsOwner(harness, createPhasedGroupEnqueue(groupId));
        harness.setLaneWaitMs(SESSION_LIFETIME_MS + 1_000);

        const updated = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.owner,
            input: toEnqueue(
                AppInboxType.GROUP_UPDATE,
                groupId,
                {
                    scope: SCOPE,
                    groupId,
                    request: { displayName: 'Too late', ...OWNER_ACTOR, requestId: `${groupId}-group_update` }
                } satisfies GroupUpdateAppInboxPayload
            )
        });

        expect(updated.left).toMatchObject({ status: 403, code: 'group-mutation-authority-denied' });
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName).toBe(groupId);
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

type LaneDelayedHarnessOptions = NonNullable<Parameters<typeof createAuthorityHarness>[1]>;

interface LaneDelayedHarness extends AuthorityHarness {
    /** Moves the lane's clock relative to the enqueue-time capture; a negative wait is a lagging lane clock. */
    setLaneWaitMs(waitMs: number): void;
}

/** The enqueue captures at the harness clock; the lane samples its attempt LANE_WAIT_MS later unless moved. */
async function createLaneDelayedHarness(options: LaneDelayedHarnessOptions): Promise<LaneDelayedHarness> {
    let laneWaitMs = LANE_WAIT_MS;
    let enqueueAtEpochMs = Number.NaN;
    const harness = await createAuthorityHarness(['owner'], {
        ...options,
        serviceOptions: { nowEpochMs: () => enqueueAtEpochMs + laneWaitMs }
    });
    enqueueAtEpochMs = harness.nowEpochMs;
    return Object.assign(harness, {
        setLaneWaitMs: (waitMs: number) => {
            laneWaitMs = waitMs;
        }
    });
}

/** A `managed` group planned against a stored layout, ready for its `connect`. */
async function createPlannedGroupHarness(groupId: string): Promise<LaneDelayedHarness> {
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
    return harness;
}

async function readFormationEpoch(harness: AuthorityHarness, groupId: string): Promise<number> {
    return (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.formationEpoch ?? 0;
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

function createPhasedGroupEnqueue(groupId: string, expiresAtEpochMs?: number): AuthenticatedGroupMutationEnqueue {
    return toEnqueue(
        AppInboxType.GROUP_CREATE,
        groupId,
        {
            scope: SCOPE,
            request: {
                groupId,
                ...(expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs }),
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
