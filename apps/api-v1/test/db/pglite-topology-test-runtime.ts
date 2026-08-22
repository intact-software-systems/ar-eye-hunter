import assert from 'node:assert/strict';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
    AppGroupInboxService,
    type TopologyAppInboxCommand
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/services/rtc-topology-ws-outbox-entry.ts';
import {
    createRtcTopologyOutboxPublisher,
    createRtcTopologyWorkHandler,
    writeRtcTopologyOutbox
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    GroupTopologyManagementService,
    materializeRtcOverlayTopologyBroadcastMessage
} from '@shared-server/rallar-system/topology/group-topology-management-service.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { Group, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { readPGliteDatabaseEpochMs } from './pglite-app-inbox-test-runtime.ts';
import { canonicalAuditStamp, groupFixture } from './pglite-state-mutation-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
interface ResourceInboxKeyFields {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
}

interface MutableJsonRecord {
    [key: string]: JsonWireValue;
}

interface RtcTopologyDeliveryState {
    readonly headSequence: number;
    readonly sequences: readonly number[];
}

interface RtcTopologyDeliveryStreamRow {
    readonly head_sequence: number;
}

interface RtcTopologyDeliveryEntryRow {
    readonly sequence: number;
}
export function submitPGliteTopologyCommand(
    appGroup: AppGroupInboxService,
    authority: IssuedAuthSession,
    command: TopologyAppInboxCommand
) {
    const type = command.operation === 'putConfig'
        ? AppInboxType.TOPOLOGY_CONFIG_PUT
        : command.operation === 'deleteConfig'
        ? AppInboxType.TOPOLOGY_CONFIG_DELETE
        : command.operation === 'putOverride'
        ? AppInboxType.TOPOLOGY_OVERRIDE_PUT
        : command.operation === 'deleteOverride'
        ? AppInboxType.TOPOLOGY_OVERRIDE_DELETE
        : AppInboxType.TOPOLOGY_RECONFIGURE;
    return appGroup.processAuthenticatedTopologyEntryUntilCompletionResult(
        {
            type,
            resourceId: command.requestId,
            contextId: [
                command.groupRef.applicationId,
                command.groupRef.workspaceId,
                command.groupRef.groupId
            ].map(encodeURIComponent).join(':'),
            senderId: command.actor.principalId,
            data: command
        },
        authority
    );
}

export function topologyConfigCommand(
    groupRef: GroupRef,
    requestId: string,
    topologyKind: 'tree' | 'mesh'
): GroupTopologyConfigMutationCommand {
    return {
        operation: 'putConfig',
        aggregateRef: groupRef,
        commandId: requestId,
        requestId,
        input: {
            config: { topologyKind },
            updatedByPrincipalId: 'owner',
            ttlMs: null,
            expiresAtEpochMs: null
        }
    };
}

export function topologyOverrideCommand(
    groupRef: GroupRef,
    requestId: string,
    topologyKind: 'tree' | 'mesh'
): GroupTopologyConfigMutationCommand {
    return {
        operation: 'putOverride',
        aggregateRef: groupRef,
        commandId: requestId,
        requestId,
        input: {
            config: { topologyKind },
            updatedByPrincipalId: 'owner',
            ttlMs: 60_000,
            expiresAtEpochMs: null
        }
    };
}

export async function createPGliteTopologyWorkFixture(
    sql: PGliteSql,
    commandId: string
) {
    const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
    const groupRef = {
        applicationId: commandId,
        workspaceId: 'atomic-work',
        groupId: 'room'
    };
    const groupSnapshot = topologyGroupSnapshot(groupRef);
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const topologySnapshotRepository = new RtcTopologySnapshotRepository(
        runtimeRepository
    );
    const topologyManagement = new GroupTopologyManagementService({
        findGroupSnapshotByRef: () => groupSnapshot,
        topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        topologySnapshotRepository,
        processRttReader: () => [],
        now: () => nowEpochMs
    });
    const executionRepository = new RtcTopologyExecutionRepository(
        runtimeRepository,
        60_000,
        () => nowEpochMs
    );
    const resourceInbox = new ResourceInboxRepository(sql);
    const workEntry = await sql.begin((transaction) =>
        writeRtcTopologyOutbox(transaction, {
            commandId,
            resourceId: `${commandId}:rtc-topology-recompute:explicit`,
            aggregateRef: groupRef,
            acceptedCausalRevision: groupSnapshot.causalRevision,
            groupSnapshot,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: nowEpochMs,
            expireAtEpochMs: FUTURE_MS,
            senderId: 'owner',
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true
        })
    );
    await sql`
    update resource_inbox
    set ri_status = 'RESERVED', ri_attempts = 1,
        start_ts = now() at time zone 'UTC', end_ts = null, next_ts = null
    where ri_topic_id = ${workEntry.key.topicId}
      and ri_resource_id = ${workEntry.key.resourceId}
      and fk_ext_bank_id = ${workEntry.key.contextId}
  `;
    const reserved = await resourceInbox.findAnyByKey(workEntry.key);
    assert.ok(reserved);
    const message = readALMessage(reserved.resource);
    const envelope = readResourceInboxKeyFields(message.payload.resource);
    const workId = [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        0
    ].join(':');
    const authority = await topologyManagement.readTopologyPlanningAuthority(
        groupRef,
        {},
        groupSnapshot
    );
    const topology = topologyManagement.computeTopologyFromAuthority(
        authority,
        undefined
    ).snapshot;
    const expiresAtEpochMs = executionRepository.publicationExpireAtTimestamp();
    const publication = {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: topology.sourceGroupStateCausalRevision,
            overlayVersion: topology.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: topology.sourceGroupStateCausalRevision,
        overlayVersion: topology.version,
        targetGroupSnapshotVersion: groupSnapshot.group.snapshotVersion,
        recipientSessionIds: topology.activeSessionIds,
        message: materializeRtcOverlayTopologyBroadcastMessage(
            groupSnapshot,
            topology,
            { workId, createdAtEpochMs: nowEpochMs, expiresAtEpochMs }
        ),
        createdAtEpochMs: nowEpochMs
    };
    const publicationEntry = computeRtcTopologyPublicationOutbox(publication);
    const queue = new PSqlQueueBox(resourceInbox);
    const publisherStreamId = '00000000-0000-4000-8000-000000000001';
    const topologyDelivery = new PSqlRtcTopologyDeliveryRepository(sql);
    let appendCount = 0;
    let replayWakeCount = 0;
    assert.equal(
        (await topologyDelivery.registerStream({
            streamId: publisherStreamId,
            leaseDurationMs: 30_000
        })).status,
        'registered'
    );
    const runtime = createRtcTopologyOutboxPublisher({
        outboxQueueReader: new OutboxQueueReader(queue),
        senderId: 'pglite-topology-worker',
        now: () => nowEpochMs
    });
    const handler = createRtcTopologyWorkHandler({
        runtime,
        database: sql,
        topologyPlanning: topologyManagement.planningService,
        executionRepository,
        topologyDelivery: {
            publisherStreamId,
            append: {
                appendOrValidate: async (transaction, input) => {
                    appendCount += 1;
                    return await topologyDelivery.appendOrValidate(transaction, input);
                }
            }
        },
        wakeReplay: () => {
            replayWakeCount += 1;
        }
    });
    return {
        groupRef,
        workId,
        topology,
        publication,
        publicationEntry,
        resourceInbox,
        executionRepository,
        workEntry,
        reserved,
        message,
        handler,
        publisherStreamId,
        readAppendCount: () => appendCount,
        readReplayWakeCount: () => replayWakeCount
    };
}

export async function readRtcTopologyDeliveryState(
    sql: PGliteSql,
    publisherStreamId: string
): Promise<RtcTopologyDeliveryState> {
    const streams = await sql<RtcTopologyDeliveryStreamRow[]>`
    select head_sequence::double precision as head_sequence
    from rtc_topology_delivery_stream
    where stream_id = ${publisherStreamId}
  `;
    const entries = await sql<RtcTopologyDeliveryEntryRow[]>`
    select sequence::double precision as sequence
    from rtc_topology_delivery_log
    where publisher_stream_id = ${publisherStreamId}
    order by sequence
  `;
    const [stream] = streams;
    assert.ok(stream);
    return {
        headSequence: stream.head_sequence,
        sequences: entries.map((entry) => entry.sequence)
    };
}

export function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            ...groupFixture(groupRef, 'Topology room'),
            ownerPrincipalId: 'owner'
        },
        members: [{
            ...groupRef,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: canonicalAuditStamp(1),
            updated: canonicalAuditStamp(1),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        }],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

interface TopologyGroupSnapshotWithSessionsInput {
    readonly groupRef: GroupRef;
    readonly ownerSessionId: string;
    readonly peerSessionId: string;
    readonly nowEpochMs: number;
}

export function topologyGroupSnapshotWithSessions(
    input: TopologyGroupSnapshotWithSessionsInput
): GroupSnapshot {
    const { groupRef, ownerSessionId, peerSessionId, nowEpochMs } = input;
    const base = topologyGroupSnapshot(groupRef);
    const peer = {
        ...base.members[0],
        principalId: 'peer',
        role: 'member' as const
    };
    const session = (sessionId: string, principalId: string) => ({
        ...groupRef,
        sessionId,
        principalId,
        generationId: `generation-${sessionId}`,
        generationVersion: nowEpochMs - 1_000,
        connectedAtEpochMs: nowEpochMs - 1_000,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
        status: 'active' as const,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    });
    return {
        stateRevision: 3,
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: {
            ...base.group,
            activeMemberCount: 2,
            snapshotVersion: 2,
            rosterVersion: 2,
            presenceVersion: 1
        },
        members: [base.members[0], peer],
        activeSessions: [
            session(ownerSessionId, 'owner'),
            session(peerSessionId, 'peer')
        ],
        memberCount: 2,
        onlineMemberCount: 2
    };
}

export function topologyGroupSnapshotWithSessionIds(
    groupRef: GroupRef,
    sessionIds: readonly string[],
    nowEpochMs: number
): GroupSnapshot {
    const base = topologyGroupSnapshot(groupRef);
    const members = sessionIds.map((_sessionId, index) => ({
        ...base.members[0],
        principalId: index === 0 ? 'owner' : `member-${index}`,
        role: index === 0 ? 'owner' as const : 'member' as const
    }));
    const activeSessions = sessionIds.map((sessionId, index) => ({
        ...groupRef,
        sessionId,
        principalId: readMemberPrincipalId(members, index),
        generationId: `generation-${sessionId}`,
        generationVersion: nowEpochMs - 100,
        connectedAtEpochMs: nowEpochMs - 100,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
        status: 'active' as const,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
    return {
        ...base,
        stateRevision: 3,
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: {
            ...base.group,
            activeMemberCount: members.length,
            snapshotVersion: 2,
            rosterVersion: 2,
            presenceVersion: 1
        },
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: members.length
    };
}

interface ActiveTopologySnapshotInput {
    readonly groupRef: GroupRef;
    readonly sourceGroupStateCausalRevision: GroupSnapshot['causalRevision'];
    readonly activeSessionIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

export function activeTopologySnapshot(
    input: ActiveTopologySnapshotInput
): RallarOverlayTopologySnapshot {
    const {
        groupRef,
        sourceGroupStateCausalRevision,
        activeSessionIds,
        nextHopsBySessionId
    } = input;
    return {
        sourceGroupStateCausalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Topology room',
        topology: 'tree',
        activeSessionIds,
        nextHopsBySessionId,
        degreeLimit: Math.max(
            1,
            ...Object.values(nextHopsBySessionId).map((peers) => peers.length)
        ),
        version: 0,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

interface CreatePGliteRemovalPlanningScenarioInput {
    readonly name: string;
    readonly status: 'active' | 'archived';
    readonly expiresAtEpochMs: number | null;
    readonly updatedAtEpochMs: number;
}

export async function createPGliteRemovalPlanningScenario(
    sql: PGliteSql,
    input: CreatePGliteRemovalPlanningScenarioInput
) {
    const nowEpochMs = 1_000;
    const groupRef = {
        applicationId: `pglite-removal-${input.name}`,
        workspaceId: 'planning',
        groupId: 'room'
    };
    const base = topologyGroupSnapshot(groupRef);
    const currentGroup: Group = input.status === 'archived'
        ? {
            ...base.group,
            status: 'archived',
            expiresAtEpochMs: input.expiresAtEpochMs,
            updated: canonicalAuditStamp(input.updatedAtEpochMs),
            archived: canonicalAuditStamp(input.updatedAtEpochMs),
            deleted: null
        }
        : {
            ...base.group,
            status: 'active',
            expiresAtEpochMs: input.expiresAtEpochMs,
            updated: canonicalAuditStamp(input.updatedAtEpochMs),
            archived: null,
            deleted: null
        };
    const current: GroupSnapshot = {
        ...base,
        group: currentGroup
    };
    const runtime = new PSqlRuntimeStateRepository(sql);
    const groups = new GroupStateRepository(runtime);
    assert.equal((await groups.insertGroup(current.group)).status, 'applied');
    for (const member of current.members) {
        await groups.putMember(member);
    }
    const durable = await groups.readSnapshot(groupRef);
    assert.ok(durable);
    const staleTerminal: GroupSnapshot = {
        ...current,
        stateRevision: 0,
        causalRevision: { groupRevision: 0, presenceRevision: 0 },
        group: {
            ...current.group,
            status: 'archived',
            updated: canonicalAuditStamp(10),
            archived: canonicalAuditStamp(10),
            expiresAtEpochMs: null,
            deleted: null
        }
    };
    const snapshots = new RtcTopologySnapshotRepository(runtime);
    const previous = activeTopologySnapshot({
        groupRef,
        sourceGroupStateCausalRevision: { groupRevision: 0, presenceRevision: 0 },
        activeSessionIds: [],
        nextHopsBySessionId: {}
    });
    assert.equal(await snapshots.observeSnapshot(previous), 'inserted');
    const service = new GroupTopologyManagementService({
        findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
        groupStateRepository: groups,
        configRepository: new GroupTopologyConfigRepository(runtime),
        topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        topologySnapshotRepository: snapshots,
        processRttReader: () => [],
        now: () => nowEpochMs
    });
    const authority = await service.readTopologyPlanningAuthority(
        groupRef,
        {},
        staleTerminal
    );
    assert.deepEqual(authority.group, durable);
    return { authority, previous, service };
}

export function advanceCoalescedGeneration(
    entry: ResourceEntry,
    generation: number
): ResourceEntry {
    const message = readMutableJsonRecord(entry.resource, 'AL message');
    const payload = readJsonRecord(message.payload, 'AL message payload');
    if (typeof payload.resource !== 'string') {
        throw new TypeError('Expected AL message payload resource');
    }
    const envelope = readMutableJsonRecord(payload.resource, 'AppInbox envelope');
    const data = readJsonRecord(envelope.data, 'AppInbox envelope data');
    const work = readJsonRecord(data.__rallarCoalescedWork, 'coalesced work');
    work.generation = generation;
    data.revision = generation;
    return {
        ...entry,
        resource: JSON.stringify({
            ...message,
            payload: { ...payload, resource: JSON.stringify(envelope) }
        })
    };
}

function readALMessage(source: string): ALMessage {
    const value = JSON.parse(source);
    validatePersistedALMessage(value);
    return value;
}

function readResourceInboxKeyFields(source: string): ResourceInboxKeyFields {
    const value: JsonWireValue = JSON.parse(source);
    if (
        !isJsonRecord(value) ||
        typeof value.topicId !== 'string' ||
        typeof value.resourceId !== 'string' ||
        typeof value.contextId !== 'string'
    ) {
        throw new TypeError('Expected resource inbox key fields');
    }
    return {
        topicId: value.topicId,
        resourceId: value.resourceId,
        contextId: value.contextId
    };
}

function readMutableJsonRecord(source: string, label: string): MutableJsonRecord {
    const value: JsonWireValue = JSON.parse(source);
    return readJsonRecord(value, label);
}

function readJsonRecord(value: JsonWireValue, label: string): MutableJsonRecord {
    if (!isJsonRecord(value)) {
        throw new TypeError(`Expected ${label} to be an object`);
    }
    return value;
}

function isJsonRecord(value: JsonWireValue): value is MutableJsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMemberPrincipalId(
    members: GroupSnapshot['members'],
    index: number
): string {
    const member = members[index];
    if (member === undefined) {
        throw new Error(`Expected topology member at index ${index}`);
    }
    return member.principalId;
}
