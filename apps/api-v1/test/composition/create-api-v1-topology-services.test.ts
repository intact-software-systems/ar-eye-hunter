import assert from 'node:assert/strict';

import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { RtcRttAppInboxCommand } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-app-inbox-contracts.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-group-state-event-store.ts';
import { GroupTopologyConfigQueryService } from '@shared-server/rallar-system/topology/config/group-topology-config-query-service.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';

import type { GroupFormationRttMutationEvent } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../../packages/tests/shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';
import { createApiV1TopologyServices, type CreateApiV1TopologyServicesInput } from '../../src/composition/create-api-v1-topology-services.ts';

const NOW_EPOCH_MS = 4_000_000_000_000;

Deno.test('topology composition installs canonical owners and RTT policy inputs', async () => {
    const runtimeStateRepository = new FakeRuntimeStateRepository();
    const snapshot = createGroupSnapshot();
    const formationEvents: GroupFormationRttMutationEvent[] = [];
    const input = createServicesInput(runtimeStateRepository, snapshot, formationEvents);

    const services = createApiV1TopologyServices(input);

    assert.ok(services.rtcTopologyService instanceof RallarRtcTopologyService);
    assert.ok(services.topologyQuery instanceof GroupTopologyConfigQueryService);
    assert.ok(services.topologyPlanning instanceof GroupTopologyPlanningService);
    assert.ok(services.topologyConfigRepository instanceof GroupTopologyConfigRepository);
    assert.ok(services.groupStateRepository instanceof GroupStateRepository);
    assert.ok(services.topologySnapshotRepository instanceof RtcTopologySnapshotRepository);
    assert.ok(services.rttRepository instanceof RtcRttRepository);
    assert.equal(services.topologyMutationOwners.configMutationService, services.topologyConfigMutation);
    assert.equal(services.topologyMutationOwners.reconfigureMutation, services.topologyReconfigureMutation);
    assert.equal(services.rtcRttMutationDependencies.repository, services.rttRepository);
    assert.equal(services.rtcRttMutationDependencies.formationMetrics, input.groupFormationRttMutation);
    assert.deepEqual(services.adminClientIds, ['admin']);
    assert.deepEqual(services.readRtcTopologyMetrics(), {
        ...services.rtcTopologyService.readMetrics(),
        replay: { replayWakeCount: 2 }
    });

    await seedReportingPairGroup(services.groupStateRepository, snapshot);
    assert.equal((await services.groupStateRepository.listAllPresenceSessions()).length, 2);
    const policy = await services.rtcRttMutationDependencies.readPolicyInputs(createRttCommand());

    // Candidates come from the durable repository, not the cached service: the
    // stubbed cache snapshot has no active sessions, so a cache read here
    // would judge the reporting pair dead.
    assert.equal(policy.candidateGroups.length, 1);
    assert.equal(policy.candidateGroups[0]!.group.groupId, 'group');
    assert.deepEqual(
        policy.candidateGroups[0]!.activeSessions.map((session) => session.sessionId).sort(),
        ['session-from', 'session-to']
    );
    assert.equal(policy.overlaySnapshotsByGroupKey.size, 0);
    assert.equal(policy.degreeLimit, 7);
    assert.deepEqual(formationEvents, []);
});

Deno.test('RTT policy inputs read only the reporting pair\'s presence rows, whatever the number of unrelated groups', async () => {
    const rowsReturned: number[] = [];
    for (const unrelatedGroupCount of [0, 16]) {
        const runtimeStateRepository = new RowCountingRuntimeStateRepository();
        const snapshot = createGroupSnapshot();
        const services = createApiV1TopologyServices(createServicesInput(runtimeStateRepository, snapshot, []));
        await seedReportingPairGroup(services.groupStateRepository, snapshot);
        for (let index = 0; index < unrelatedGroupCount; index += 1) {
            await services.groupStateRepository.putPresenceSession({
                ...createPresenceSession(`unrelated-session-${index}`, `unrelated-${index}`),
                groupId: `unrelated-group-${index}`
            });
        }
        runtimeStateRepository.rowsReturned = 0;

        const policy = await services.rtcRttMutationDependencies.readPolicyInputs(createRttCommand());

        assert.deepEqual(policy.candidateGroups.map((group) => group.group.groupId), ['group']);
        rowsReturned.push(runtimeStateRepository.rowsReturned);
    }
    assert.equal(rowsReturned[1], rowsReturned[0]);
});

class RowCountingRuntimeStateRepository extends FakeRuntimeStateRepository {
    rowsReturned = 0;

    override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        const entries = await super.findAllEntries(namespace);
        this.rowsReturned += entries.length;
        return entries;
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const selections = await super.readRuntimeStateBatch(selectors);
        this.rowsReturned += selections.reduce((total, selection) => total + selection.entries.length, 0);
        return selections;
    }
}

function createServicesInput(
    runtimeStateRepository: FakeRuntimeStateRepository,
    snapshot: GroupSnapshot,
    formationEvents: GroupFormationRttMutationEvent[]
): CreateApiV1TopologyServicesInput {
    return {
        pendingReplanReader: {
            findByKey: () => Promise.reject(new Error('pending replan not read by construction test'))
        },
        runtimeStateRepository,
        groupStateRepository: new GroupStateRepository(
            runtimeStateRepository,
            new InMemoryGroupStateEventStore()
        ),
        groupStateService: {
            readSnapshotAtLeast: () => Promise.resolve(snapshot)
        },
        groupFormationRttMutation: (event) => formationEvents.push(event),
        topologyOutboxWritten: () => undefined,
        topologyReplayMetrics: {
            readMetrics: () => ({ replayWakeCount: 2 }),
            resetMetrics: () => {}
        },
        adminClientIds: ['admin'],
        rtcTopologyOptions: { rttReportingDegreeLimit: 7 },
        rttRefinementGateConfig: {
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5
        },
        nowEpochMs: () => NOW_EPOCH_MS
    };
}

async function seedReportingPairGroup(repository: GroupStateRepository, snapshot: GroupSnapshot): Promise<void> {
    const sessionFrom = createPresenceSession('session-from', 'alice');
    const sessionTo = createPresenceSession('session-to', 'bob');
    await repository.putGroup(snapshot.group);
    await repository.putMember(createActiveMember('alice'));
    await repository.putMember(createActiveMember('bob'));
    await repository.putPresenceSession(sessionFrom);
    await repository.putPresenceSession(sessionTo);
    await repository.insertPresenceSummary({
        applicationId: 'app',
        workspaceId: 'workspace',
        groupId: 'group',
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        activePrincipalIds: ['alice', 'bob'],
        activeSessionIds: ['session-from', 'session-to'],
        activeSessions: [sessionFrom, sessionTo],
        activePrincipalCount: 2,
        activeSessionCount: 2,
        computedAtEpochMs: 1
    });
}

function createRttCommand(): RtcRttAppInboxCommand {
    return {
        actor: { principalId: 'alice', sessionId: 'session-from' },
        requestId: 'request-1',
        commandHash: `sha256:${'1'.repeat(64)}`,
        mutationCommandHash: `sha256:${'2'.repeat(64)}`,
        capturedAtEpochMs: NOW_EPOCH_MS,
        rtt: {
            sessionIdFrom: 'session-from',
            sessionIdTo: 'session-to',
            rttMs: 12,
            createdAtEpochMs: NOW_EPOCH_MS,
            version: 1
        }
    };
}

function createActiveMember(principalId: string): GroupMember {
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'session' as const, principalId, sessionId: `session-${principalId}` },
        reason: null,
        traceId: null,
        requestId: `join-${principalId}`
    };
    return {
        applicationId: 'app',
        workspaceId: 'workspace',
        groupId: 'group',
        principalId,
        role: principalId === 'alice' ? 'owner' : 'member',
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

function createPresenceSession(
    sessionId: string,
    principalId: string
): GroupPresenceSession {
    return {
        applicationId: 'app',
        workspaceId: 'workspace',
        groupId: 'group',
        sessionId,
        principalId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 2,
        expiresAtEpochMs: NOW_EPOCH_MS + 1_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createGroupSnapshot(): GroupSnapshot {
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'session' as const, principalId: 'owner', sessionId: 'owner-session' },
        reason: null,
        traceId: null,
        requestId: 'create-group'
    };
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'group',
            displayName: 'Group',
            activeMemberCount: 2,
            ownerPrincipalId: 'alice',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: audit,
            updated: audit
        }),
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
}
