import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/\
p-sql-rtc-topology-delivery-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/\
PSqlRuntimeStateRepository.ts';
import {
  type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/\
GroupStateRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/\
RtcTopologyExecutionRepository.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/repositories/\
RtcTopologyPublicationRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/\
RtcTopologySnapshotRepository.ts';
import {
  AppGroupInboxService,
  type TopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  AppInboxService,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  createRtcTopologyOutboxPublisher,
  createRtcTopologyWorkHandler,
  writeRtcTopologyOutbox,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import {
  type GroupMutationDescriptor,
  type GroupMutationPreparation,
  type GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import {
  type JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/\
rallar-rtc-topology-service.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/services/\
rtc-topology-ws-outbox-entry.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/\
config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/\
persistence/group-topology-config-repository.ts';
import {
  GroupTopologyManagementService,
  materializeRtcOverlayTopologyBroadcastMessage,
} from '@shared-server/rallar-system/topology/\
group-topology-management-service.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/\
group-topology-config-canonical.ts';
import type {
  AuditStamp,
  Group,
  GroupEvent,
  GroupRef,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import {
  EntityStatus,
  type ResourceEntry,
  toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');

interface ResourceInboxStatusRow {
  readonly ri_type_id: string;
  readonly ri_status: string;
}

interface NumericCountRow {
  readonly count: string | number;
}

interface StringCountRow {
  readonly count: string;
}

interface ResourceInboxLifecycleRow {
  readonly ri_resource_id: string;
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
  readonly ri_status: string;
  readonly ri_resource: string;
}

interface ResourceInboxForeignKeyRow {
  readonly ri_topic_id: string;
  readonly ri_resource_id: string;
  readonly fk_ext_bank_id: string;
}

interface ResourceInboxTopicTypeRow {
  readonly ri_topic_id: string;
  readonly ri_type_id: string;
}

interface NumericValueRow {
  readonly value: number;
}

interface StringValueRow {
  readonly value: string;
}

interface RuntimeStateExpiryRow {
  readonly store_key: string;
  readonly expire_at_ts: string;
}

interface ResourceInboxAttemptStatusRow {
  readonly ri_attempts: string | number;
  readonly ri_status: string;
}

interface ResourceInboxPayloadRow {
  readonly ri_resource: string;
}

interface EpochMillisecondsRow {
  readonly epoch_ms: string | number;
}

interface GroupEventWorkspaceRow {
  readonly workspace_key: string;
}

interface CreatedTimestampRow {
  readonly created_ts: string;
}

interface ExpireTimestampRow {
  readonly expire_ts: string;
}

interface StartTimestampRow {
  readonly start_ts: string;
}

interface EndTimestampRow {
  readonly end_ts: string;
}

interface TopologyCommandPayload {
  readonly data: TopologyAppInboxCommand;
}

interface DurableTopologyAuthorityProof {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sessionIssuedAtEpochMs: number;
}

interface DurableTopologyAuthorityValue {
  readonly proof: DurableTopologyAuthorityProof;
}

interface DurableTopologyAuthority {
  readonly authority: DurableTopologyAuthorityValue;
}

interface ResourceInboxKeyFields {
  readonly topicId: string;
  readonly resourceId: string;
  readonly contextId: string;
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
export function groupFixture(ref: GroupRef, displayName: string): Group {
  const audit = canonicalAuditStamp(1);
  return createTestGroup({
    ...ref,
    displayName,
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
  });
}

export function submitPGliteTopologyCommand(
  appGroup: AppGroupInboxService,
  authority: IssuedAuthSession,
  command: TopologyAppInboxCommand,
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
  return appGroup.processAuthenticatedEntryUntilCompletion({
    type,
    resourceId: command.requestId,
    contextId: [
      command.groupRef.applicationId,
      command.groupRef.workspaceId,
      command.groupRef.groupId,
    ].map(encodeURIComponent).join(':'),
    senderId: command.actor.principalId,
    data: command,
  }, authority);
}

export function topologyConfigCommand(
  groupRef: GroupRef,
  requestId: string,
  topologyKind: 'tree' | 'mesh',
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
      expiresAtEpochMs: null,
    },
  };
}

export function topologyOverrideCommand(
  groupRef: GroupRef,
  requestId: string,
  topologyKind: 'tree' | 'mesh',
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
      expiresAtEpochMs: null,
    },
  };
}

export async function createPGliteTopologyWorkFixture(
  sql: PGliteSql,
  commandId: string,
) {
  const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
  const groupRef = {
    applicationId: commandId,
    workspaceId: 'atomic-work',
    groupId: 'room',
  };
  const groupSnapshot = topologyGroupSnapshot(groupRef);
  const runtimeRepository = new PSqlRuntimeStateRepository(sql);
  const topologySnapshotRepository = new RtcTopologySnapshotRepository(
    runtimeRepository,
  );
  const topologyManagement = new GroupTopologyManagementService({
    findGroupSnapshotByRef: () => groupSnapshot,
    topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
    topologySnapshotRepository,
    processRttReader: () => [],
    now: () => nowEpochMs,
  });
  const executionRepository = new RtcTopologyExecutionRepository(
    runtimeRepository,
    60_000,
    () => nowEpochMs,
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
      publish: true,
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
  const message = JSON.parse(reserved.resource) as ALMessage;
  const envelope = JSON.parse(message.payload.resource) as ResourceInboxKeyFields;
  const workId = [
    envelope.topicId,
    envelope.contextId,
    envelope.resourceId,
    0,
  ].join(':');
  const authority = await topologyManagement.readTopologyPlanningAuthority(
    groupRef,
    {},
    groupSnapshot,
  );
  const topology = topologyManagement.computeTopologyFromAuthority(
    authority,
    undefined,
  ).snapshot;
  const expiresAtEpochMs = executionRepository.publicationExpireAtTimestamp();
  const publication = {
    publicationId: toRtcTopologyPublicationId({
      workId,
      sourceGroupStateCausalRevision: topology.sourceGroupStateCausalRevision,
      overlayVersion: topology.version,
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
      { workId, createdAtEpochMs: nowEpochMs, expiresAtEpochMs },
    ),
    createdAtEpochMs: nowEpochMs,
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
      leaseDurationMs: 30_000,
    })).status,
    'registered',
  );
  const runtime = createRtcTopologyOutboxPublisher({
    outboxQueueReader: new OutboxQueueReader(queue),
    senderId: 'pglite-topology-worker',
    now: () => nowEpochMs,
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
        },
      },
    },
    wakeReplay: () => {
      replayWakeCount += 1;
    },
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
    readReplayWakeCount: () => replayWakeCount,
  };
}

export async function readRtcTopologyDeliveryState(
  sql: PGliteSql,
  publisherStreamId: string,
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
  return {
    headSequence: streams[0]!.head_sequence,
    sequences: entries.map((entry) => entry.sequence),
  };
}

export function topologyGroupSnapshot(groupRef: GroupRef): GroupSnapshot {
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: {
      ...groupFixture(groupRef, 'Topology room'),
      ownerPrincipalId: 'owner',
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
      invitationExpiresAtEpochMs: null,
    }],
    activeSessions: [],
    memberCount: 1,
    onlineMemberCount: 0,
  };
}

interface TopologyGroupSnapshotWithSessionsInput {
  readonly groupRef: GroupRef;
  readonly ownerSessionId: string;
  readonly peerSessionId: string;
  readonly nowEpochMs: number;
}

export function topologyGroupSnapshotWithSessions(
  input: TopologyGroupSnapshotWithSessionsInput,
): GroupSnapshot {
  const { groupRef, ownerSessionId, peerSessionId, nowEpochMs } = input;
  const base = topologyGroupSnapshot(groupRef);
  const peer = {
    ...base.members[0],
    principalId: 'peer',
    role: 'member' as const,
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
    disconnectReason: null,
  });
  return {
    stateRevision: 3,
    causalRevision: { groupRevision: 2, presenceRevision: 1 },
    group: {
      ...base.group,
      activeMemberCount: 2,
      snapshotVersion: 2,
      rosterVersion: 2,
      presenceVersion: 1,
    },
    members: [base.members[0], peer],
    activeSessions: [
      session(ownerSessionId, 'owner'),
      session(peerSessionId, 'peer'),
    ],
    memberCount: 2,
    onlineMemberCount: 2,
  };
}

export function topologyGroupSnapshotWithSessionIds(
  groupRef: GroupRef,
  sessionIds: readonly string[],
  nowEpochMs: number,
): GroupSnapshot {
  const base = topologyGroupSnapshot(groupRef);
  const members = sessionIds.map((_sessionId, index) => ({
    ...base.members[0],
    principalId: index === 0 ? 'owner' : `member-${index}`,
    role: index === 0 ? 'owner' as const : 'member' as const,
  }));
  const activeSessions = sessionIds.map((sessionId, index) => ({
    ...groupRef,
    sessionId,
    principalId: members[index]!.principalId,
    generationId: `generation-${sessionId}`,
    generationVersion: nowEpochMs - 100,
    connectedAtEpochMs: nowEpochMs - 100,
    lastHeartbeatAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + 60_000,
    status: 'active' as const,
    disconnectedAtEpochMs: null,
    disconnectReason: null,
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
      presenceVersion: 1,
    },
    members,
    activeSessions,
    memberCount: members.length,
    onlineMemberCount: members.length,
  };
}

interface ActiveTopologySnapshotInput {
  readonly groupRef: GroupRef;
  readonly sourceGroupStateCausalRevision: GroupSnapshot['causalRevision'];
  readonly activeSessionIds: readonly string[];
  readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

export function activeTopologySnapshot(
  input: ActiveTopologySnapshotInput,
): RallarOverlayTopologySnapshot {
  const {
    groupRef,
    sourceGroupStateCausalRevision,
    activeSessionIds,
    nextHopsBySessionId,
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
      ...Object.values(nextHopsBySessionId).map((peers) => peers.length),
    ),
    version: 0,
    createdByClientId: 'owner',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
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
  input: CreatePGliteRemovalPlanningScenarioInput,
) {
  const nowEpochMs = 1_000;
  const groupRef = {
    applicationId: `pglite-removal-${input.name}`,
    workspaceId: 'planning',
    groupId: 'room',
  };
  const base = topologyGroupSnapshot(groupRef);
  const currentGroup: Group = input.status === 'archived'
    ? {
      ...base.group,
      status: 'archived',
      expiresAtEpochMs: input.expiresAtEpochMs,
      updated: canonicalAuditStamp(input.updatedAtEpochMs),
      archived: canonicalAuditStamp(input.updatedAtEpochMs),
      deleted: null,
    }
    : {
      ...base.group,
      status: 'active',
      expiresAtEpochMs: input.expiresAtEpochMs,
      updated: canonicalAuditStamp(input.updatedAtEpochMs),
      archived: null,
      deleted: null,
    };
  const current: GroupSnapshot = {
    ...base,
    group: currentGroup,
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
      deleted: null,
    },
  };
  const snapshots = new RtcTopologySnapshotRepository(runtime);
  const previous = activeTopologySnapshot({
    groupRef,
    sourceGroupStateCausalRevision: { groupRevision: 0, presenceRevision: 0 },
    activeSessionIds: [],
    nextHopsBySessionId: {},
  });
  assert.equal(await snapshots.observeSnapshot(previous), 'inserted');
  const service = new GroupTopologyManagementService({
    findGroupSnapshotByRef: (ref) => groups.readSnapshot(ref),
    groupStateRepository: groups,
    configRepository: new GroupTopologyConfigRepository(runtime),
    topologyService: new RallarRtcTopologyService({ now: () => nowEpochMs }),
    topologySnapshotRepository: snapshots,
    processRttReader: () => [],
    now: () => nowEpochMs,
  });
  const authority = await service.readTopologyPlanningAuthority(
    groupRef,
    {},
    staleTerminal,
  );
  assert.deepEqual(authority.group, durable);
  return { authority, previous, service };
}

export async function readPGliteDatabaseEpochMs(sql: PGliteSql): Promise<number> {
  const [clock] = await sql<EpochMillisecondsRow[]>`
    select floor(extract(epoch from now()) * 1000)::bigint as epoch_ms
  `;
  assert.ok(clock);
  return Number(clock.epoch_ms);
}

export async function readPGliteAppInboxFailure(
  sql: PGliteSql,
  resourceId: string,
  resource: JsonWireValue,
) {
  const inbox = new ResourceInboxRepository(sql);
  const results = new ResourceInboxResultsRepository(sql);
  const service = new AppInboxService(
    {
      inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(inbox)),
      resourceInboxRepository: inbox,
      resourceInboxResultsRepository: results,
      database: sql,
    },
    {
      serviceId: 'pglite-legacy-failure-reader',
      options: {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 2,
        waitJitterRatio: 0,
      },
    },
  );
  const enqueue = {
    type: AppInboxType.GROUP_CREATE,
    resourceId,
    contextId: 'legacy-context',
    data: { requestId: resourceId },
  } as const;
  const typedPending = service.processEntryUntilCompletionResult(enqueue, (value) => value);
  await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
  const key = {
    topicId: 'app-inbox.group-state',
    resourceId,
    contextId: enqueue.contextId,
  };
  const entry = await inbox.findByKey(key);
  assert.ok(entry);
  const reserved = await inbox.startProcessingEntity(entry);
  assert.ok(reserved.right);
  await results.replace(
    toResourceEntryWithUpdatedResource(
      reserved.right,
      EntityStatus.FAILED,
      resource,
    ),
  );
  assert.ok(
    await inbox.finishReserved(
      key,
      reserved.right.dequeueAudit.attempts,
      EntityStatus.FAILED,
      new Date(),
    ),
  );
  const typed = await typedPending;
  const legacy = await service.processEntryUntilCompletion(enqueue);
  return { typed, legacy };
}

export async function waitForPGliteQueueRow(
  sql: PGliteSql,
  typeId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await sql<StringCountRow[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = ${typeId} and ri_status = ${status}
    `;
    if (Number(row?.count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${typeId} ${status} queue row`);
}

interface ApplyPGliteGroupMutationInput {
  readonly sql: PGliteSql;
  readonly service: GroupStateService;
  readonly descriptor: GroupMutationDescriptor;
  readonly authority: IssuedAuthSession;
}

export async function applyPGliteGroupMutation(
  input: ApplyPGliteGroupMutationInput,
): Promise<void> {
  const { sql, service, descriptor, authority } = input;
  await applyPreparedPGliteGroupMutation(
    sql,
    service,
    await service.prepareMutation(descriptor, authority),
  );
}

export async function applyPreparedPGliteGroupMutation(
  sql: PGliteSql,
  service: GroupStateService,
  preparation: GroupMutationPreparation,
): Promise<void> {
  const command = {
    ...preparation,
    facts: { ...preparation.facts, attemptCount: 1 },
  };
  const read = await service.read(command);
  const computed = service.compute(command, read);
  service.validate(command, read, computed);
  if (computed.outcome !== 'write') {
    return;
  }
  await sql.begin(async (transaction) => {
    await service.write(transaction, computed);
  });
}

interface CreateClientStateEventInput {
  readonly eventId: string;
  readonly occurredAtEpochMs: number;
  readonly snapshotVersion: number;
  readonly eventType?: ClientEvent['eventType'];
  readonly overrides?: Partial<ClientEvent>;
}

export function createClientStateEvent(input: CreateClientStateEventInput): ClientEvent {
  const {
    eventId,
    occurredAtEpochMs,
    snapshotVersion,
    eventType = 'session-connected',
    overrides = {},
  } = input;
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    principalId: 'principal-1',
    eventId,
    eventType,
    snapshotVersion,
    occurredAtEpochMs,
    clientInstanceId: 'instance-1',
    sessionId: 'session-1',
    actor: {
      kind: 'service',
      serviceId: 'pglite-test',
    },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
    ...overrides,
  };
}

interface CreateGroupStateEventInput {
  readonly eventId: string;
  readonly occurredAtEpochMs: number;
  readonly snapshotVersion: number;
  readonly eventType?: GroupEvent['eventType'];
  readonly overrides?: Partial<GroupEvent>;
}

export function createGroupStateEvent(input: CreateGroupStateEventInput): GroupEvent {
  const {
    eventId,
    occurredAtEpochMs,
    snapshotVersion,
    eventType = 'session-connected',
    overrides = {},
  } = input;
  return {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1',
    eventId,
    eventType,
    snapshotVersion,
    causalRevision: {
      groupRevision: snapshotVersion,
      presenceRevision: 0,
    },
    occurredAtEpochMs,
    actor: {
      kind: 'service',
      serviceId: 'pglite-test',
    },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
    ...overrides,
  };
}

export function canonicalAuditStamp(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'pglite-test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}

const CRDT_ROOM_REF = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  groupId: 'room-1',
};

export const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
  applicationId: 'rallar-test',
  workspaceId: 'main',
  scope: 'room',
  documentType: 'checklist',
  documentId: 'room-1',
  roomRef: CRDT_ROOM_REF,
};

interface CreateResourceEntryOptions {
  readonly topicId?: string;
  readonly contextId?: string;
  readonly typeId?: string;
  readonly status?: EntityStatus;
  readonly payload?: JsonWireValue;
  readonly expiryTs?: Temporal.Instant;
}

export function createResourceEntry(
  resourceId: string,
  options: CreateResourceEntryOptions = {},
): ResourceEntry {
  return {
    key: {
      topicId: options.topicId ?? 'topic-smoke',
      resourceId,
      contextId: options.contextId ?? 'ctx-smoke',
    },
    resource: JSON.stringify(options.payload ?? { resourceId }),
    typeId: options.typeId ?? 'TYPE_A',
    status: options.status ?? EntityStatus.NEW,
    audit: {
      date: CREATED_TS.toPlainTime(),
      createdBy: 'tester',
      createdTs: CREATED_TS,
      expiryTs: options.expiryTs ?? FUTURE_INSTANT,
    },
    dequeueAudit: {
      attempts: 0,
    },
  };
}

export class PGliteTestSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';
  readonly readyState = WebSocket.OPEN;
  readonly url = 'ws://pglite-test.invalid';
  binaryType: BinaryType = 'blob';
  onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocket, event: Event) => void) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
  onopen: ((this: WebSocket, event: Event) => void) | null = null;
  private readonly messageListeners = new Set<EventListenerOrEventListenerObject>();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === 'message' && callback !== null) {
      this.messageListeners.add(callback);
      return;
    }
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === 'message' && callback !== null) {
      this.messageListeners.delete(callback);
      return;
    }
    super.removeEventListener(type, callback, options);
  }

  close(): void {}

  send(): void {}

  async dispatchMessage(message: ALMessage): Promise<void> {
    const event = new MessageEvent('message', { data: JSON.stringify(message) });
    for (const listener of this.messageListeners) {
      if (typeof listener === 'function') {
        await listener.call(this, event);
      } else {
        await listener.handleEvent(event);
      }
    }
    await this.onmessage?.call(this, event);
  }
}

export function advanceCoalescedGeneration(
  entry: ResourceEntry,
  generation: number,
): ResourceEntry {
  const message = JSON.parse(entry.resource);
  const envelope = JSON.parse(message.payload.resource);
  envelope.data.__rallarCoalescedWork.generation = generation;
  envelope.data.revision = generation;
  message.payload.resource = JSON.stringify(envelope);
  return {
    ...entry,
    resource: JSON.stringify(message),
  };
}
