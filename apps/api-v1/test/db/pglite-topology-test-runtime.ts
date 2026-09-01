import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    decodeJsonWireText,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import {
    type TopologyAppInboxCommand
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import type { TopologyAppInboxMutationOwners } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import type { GroupTopologyMutationOwners } from '@shared-server/rallar-system/topology/mutation/create-group-topology-mutation-owners.ts';
import {
    createRtcTopologyOutboxPublisher
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { materializeRtcOverlayTopologyBroadcastMessage } from '@shared-server/rallar-system/topology/planning/materialize-rtc-overlay-topology-broadcast-message.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import {
    createGroupTopologyRuntimeOwners,
    type GroupTopologyRuntimeOwners
} from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { requirePlannedTopology } from '@shared-test/shared-server/require-planned-topology.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { readPGliteDatabaseEpochMs } from './pglite-app-inbox-test-runtime.ts';
import { canonicalAuditStamp, groupFixture } from './pglite-state-mutation-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
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
    appGroup: TopologyInboxService,
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
    return appGroup.processAuthenticatedEntryUntilCompletionResult(
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

export function requireTopologyMutationOwners(
    owners: GroupTopologyMutationOwners
): TopologyAppInboxMutationOwners {
    return {
        configMutationService: owners.configMutation,
        reconfigureMutation: owners.reconfigureMutation
    };
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

interface PGliteTopologyWorkSetup {
    readonly sql: PGliteSql;
    readonly nowEpochMs: number;
    readonly groupRef: GroupRef;
    readonly groupSnapshot: GroupSnapshot;
    readonly topologyManagement: GroupTopologyRuntimeOwners;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly resourceInbox: PSqlResourceInboxRepository;
}

interface ReservedPGliteTopologyWork {
    readonly workEntry: ResourceEntry;
    readonly reserved: ResourceEntry;
    readonly message: ALMessage;
    readonly workId: string;
}

interface PlannedPGliteTopologyPublication {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly publication: RtcTopologyPublication;
    readonly publicationEntry: ResourceEntry;
}

interface PGliteTopologyWorkDelivery {
    readonly handler: OnMessageCallback;
    readonly publisherStreamId: string;
    readAppendCount(): number;
    readReplayWakeCount(): number;
}

interface PGliteTopologyWorkFixture
    extends ReservedPGliteTopologyWork, PlannedPGliteTopologyPublication, PGliteTopologyWorkDelivery {
    readonly groupRef: GroupRef;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly executionRepository: RtcTopologyExecutionRepository;
}

export async function createPGliteTopologyWorkFixture(
    sql: PGliteSql,
    commandId: string
): Promise<PGliteTopologyWorkFixture> {
    const setup = await createPGliteTopologyWorkSetup(sql, commandId);
    const reserved = await persistAndReserveTopologyWork(setup, commandId);
    const planned = await planTopologyWorkPublication(setup, reserved.workId);
    const delivery = await registerTopologyWorkDelivery(setup);
    return {
        ...reserved,
        ...planned,
        ...delivery,
        groupRef: setup.groupRef,
        resourceInbox: setup.resourceInbox,
        executionRepository: setup.executionRepository
    };
}

async function createPGliteTopologyWorkSetup(sql: PGliteSql, commandId: string): Promise<PGliteTopologyWorkSetup> {
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
    const topologyManagement = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => groupSnapshot,
        readCurrentGroupSnapshot: async () => groupSnapshot,
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        topologySnapshotRepository
    });
    const executionRepository = new RtcTopologyExecutionRepository(
        runtimeRepository,
        60_000,
        () => nowEpochMs
    );
    const resourceInbox = createPSqlResourceInboxRepository(sql);
    return { sql, nowEpochMs, groupRef, groupSnapshot, topologyManagement, executionRepository, resourceInbox };
}

async function persistAndReserveTopologyWork(
    setup: PGliteTopologyWorkSetup,
    commandId: string
): Promise<ReservedPGliteTopologyWork> {
    const { sql, groupRef, groupSnapshot, nowEpochMs, resourceInbox } = setup;
    const workEntry = await sql.begin((transaction) =>
        new RtcTopologyOutboxWriter({ recordWrite: () => undefined }).write(transaction, {
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
    const reserved = await resourceInbox.entries.findAnyByKey(workEntry.key);
    assert.ok(reserved);
    const message = decodePersistedALMessage(reserved.resource);
    const envelope = readResourceInboxKeyFields(message.payload.resource);
    const workId = [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        0
    ].join(':');
    return { workEntry, reserved, message, workId };
}

async function planTopologyWorkPublication(
    setup: PGliteTopologyWorkSetup,
    workId: string
): Promise<PlannedPGliteTopologyPublication> {
    const { groupRef, groupSnapshot, topologyManagement, executionRepository, nowEpochMs } = setup;
    const authority = await topologyManagement.planning.readTopologyPlanningAuthority({
        groupRef,
        requestOptions: {},
        knownGroup: groupSnapshot,
        snapshotSelection: 'prefer-current'
    });
    const topology = requirePlannedTopology(
        topologyManagement.planning.computeTopologyFromAuthority(authority, undefined, {
            intent: 'full-rebuild',
            origin: 'automatic'
        })
    ).snapshot;
    const expiresAtEpochMs = executionRepository.publicationExpireAtTimestamp();
    const publication: RtcTopologyPublication = {
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
    return { topology, publication, publicationEntry };
}

async function registerTopologyWorkDelivery(setup: PGliteTopologyWorkSetup): Promise<PGliteTopologyWorkDelivery> {
    const { sql, resourceInbox, topologyManagement, executionRepository, nowEpochMs } = setup;
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
        topologyPlanning: topologyManagement.planning,
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
    const owner = base.members[0];
    assert.ok(owner);
    const peer: GroupMember = {
        ...owner,
        principalId: 'peer',
        role: 'member'
    };
    const session = (sessionId: string, principalId: string): GroupPresenceSession => ({
        ...groupRef,
        sessionId,
        principalId,
        generationId: `generation-${sessionId}`,
        generationVersion: nowEpochMs - 1_000,
        connectedAtEpochMs: nowEpochMs - 1_000,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    });
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: {
            ...base.group,
            activeMemberCount: 2,
            snapshotVersion: 2,
            rosterVersion: 2,
            presenceVersion: 1
        },
        members: [owner, peer],
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
    const owner = base.members[0];
    assert.ok(owner);
    const members = sessionIds.map((_sessionId, index): GroupMember => ({
        ...owner,
        principalId: index === 0 ? 'owner' : `member-${index}`,
        role: index === 0 ? 'owner' : 'member'
    }));
    const activeSessions = sessionIds.map((sessionId, index): GroupPresenceSession => ({
        ...groupRef,
        sessionId,
        principalId: readMemberPrincipalId(members, index),
        generationId: `generation-${sessionId}`,
        generationVersion: nowEpochMs - 100,
        connectedAtEpochMs: nowEpochMs - 100,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
    return {
        ...base,
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

interface PGliteRemovalPlanningScenario {
    readonly authority: GroupTopologyPlanningAuthority;
    readonly previous: RallarOverlayTopologySnapshot;
    readonly service: GroupTopologyRuntimeOwners;
}

export async function createPGliteRemovalPlanningScenario(
    sql: PGliteSql,
    input: CreatePGliteRemovalPlanningScenarioInput
): Promise<PGliteRemovalPlanningScenario> {
    const nowEpochMs = 1_000;
    const groupRef = {
        applicationId: `pglite-removal-${input.name}`,
        workspaceId: 'planning',
        groupId: 'room'
    };
    const runtime = new PSqlRuntimeStateRepository(sql);
    const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
    const current = await seedRemovalPlanningGroup(groups, groupRef, input);
    const durable = await groups.readSnapshot(groupRef);
    assert.ok(durable);
    const staleTerminal: GroupSnapshot = {
        ...current,
        causalRevision: { groupRevision: 0, presenceRevision: 0 },
        group: {
            ...current.group,
            snapshotVersion: 0,
            presenceVersion: 0,
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
    const service = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await groups.readSnapshot(ref),
        readRttMeasurements: () => [],
        configRepository: new GroupTopologyConfigRepository(runtime),
        topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
        topologySnapshotRepository: snapshots
    });
    const authority = await service.planning.readTopologyPlanningAuthority({
        groupRef,
        requestOptions: {},
        knownGroup: staleTerminal,
        snapshotSelection: 'prefer-current'
    });
    assert.deepEqual(authority.group, durable);
    return { authority, previous, service };
}

async function seedRemovalPlanningGroup(
    groups: GroupStateRepository,
    groupRef: GroupRef,
    input: CreatePGliteRemovalPlanningScenarioInput
): Promise<GroupSnapshot> {
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
    assert.equal((await groups.insertGroup(current.group)).status, 'applied');
    for (const member of current.members) {
        await groups.putMember(member);
    }
    return current;
}

export function advanceCoalescedGeneration(
    entry: ResourceEntry,
    generation: number
): ResourceEntry {
    const message = decodePersistedALMessage(entry.resource);
    const envelope = readJsonRecord(
        decodeJsonWireText(message.payload.resource, 'AppInbox envelope'),
        'AppInbox envelope'
    );
    const data = readJsonRecord(envelope.data, 'AppInbox envelope data');
    const work = readJsonRecord(data.__rallarCoalescedWork, 'coalesced work');
    const successor = {
        ...envelope,
        data: { ...data, revision: generation, __rallarCoalescedWork: { ...work, generation } }
    };
    return {
        ...entry,
        resource: JSON.stringify({
            ...message,
            payload: { ...message.payload, resource: JSON.stringify(successor) }
        })
    };
}

function readResourceInboxKeyFields(source: string): Key {
    const value = decodeJsonWireText(source, 'Resource inbox key');
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

function readJsonRecord(value: JsonWireValue | undefined, label: string): JsonWireObject {
    if (value === undefined || !isJsonRecord(value)) {
        throw new TypeError(`Expected ${label} to be an object`);
    }
    return value;
}

function isJsonRecord(value: JsonWireValue): value is JsonWireObject {
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
