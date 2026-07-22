import {
    type ALMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import {
    fromCanonicalGroupTopologyConfigPatch,
    readCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
import {
    readGroupStateRevision,
} from '@shared/api/group-client-views.ts';
import type {
    GroupRef,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import {
    hashRtcTopologyExecutionCommand,
    type RtcTopologyPublication,
    toRtcTopologyPublicationId,
} from '../repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyExecutionRepository } from '../repositories/RtcTopologyExecutionRepository.ts';
import {
    toCanonicalRtcTopologyPairIdentity,
} from '../rtc-topology-identifiers.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
} from './rtc-topology-mutations.ts';
import type { RallarTimingSink } from './timing.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { AppOutboxType } from './AppOutboxService.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkMetadata,
    type CoalescedAppOutboxWorkData,
    CoalescedAppOutboxWorkService,
} from './CoalescedAppOutboxWorkService.ts';
import {
    toAppQueueCreatedBy,
    toAppQueueKey,
} from './app-inbox-queue-key.ts';
import {
    type GroupTopologyManagementService,
    materializeRtcOverlayTopologyBroadcastMessage,
    type RtcOverlayTopologyMessageFacts,
} from './group-topology-management-service.ts';
import { validatePersistedALMessage } from './al-message-persistence-validation.ts';
import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import { runInTransaction } from '../../postgres/run-in-transaction.ts';
import { writeRtcTopologyPublicationOutbox } from './rtc-topology-ws-outbox-entry.ts';
export {
    APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
    computeRtcTopologyEntry,
    type ComputedRtcTopologyOutbox,
    writeRtcTopologyOutbox,
} from './rtc-topology-outbox-entry.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from './rtc-topology-outbox-entry.ts';

export type RtcTopologyGroupRevisionWork = Readonly<{
    kind: 'group-revision';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    sourceGroupStateRevision: number;
    requestedAtEpochMs: number;
    requestOptions: CanonicalGroupTopologyConfigPatch;
    publish: boolean;
}>;

export type RtcTopologyRttRefreshWork = Readonly<{
    kind: 'rtt-refresh';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    requestedGroupStateRevision: number;
    requestedRttVersion: number;
    requestedAtEpochMs: number;
    requestOptions: CanonicalGroupTopologyConfigPatch;
    publish: boolean;
}>;

export type RtcTopologyStateMutationPublisher = Readonly<{
    enqueueForStateMutation(
        group: GroupSnapshot,
        deliveryId: string,
    ): Promise<RtcTopologyGroupEnqueueResult>;
}>;

export type RtcTopologyWorkPublisher =
    & RtcTopologyStateMutationPublisher
    & Readonly<{
        enqueueForGroupSnapshot(group: GroupSnapshot): Promise<void>;
        enqueueForRtt(
            group: GroupSnapshot,
            rtt: RttMeasurementInfo,
            debounceMs: number,
        ): Promise<void>;
        enqueueForRttGroups(
            rtt: RttMeasurementInfo,
            groups: readonly GroupSnapshot[],
            debounceMs: number,
        ): Promise<void>;
    }>;

export type RtcTopologyGroupEnqueueResult = Readonly<{
    effectiveSnapshotRevision: number;
}>;

export type RtcTopologyWorkRuntime = Readonly<{
    service: CoalescedAppOutboxWorkService;
    outboxQueueReader: OutboxQueueReader;
    publisher: RtcTopologyWorkPublisher;
    workType: string;
    topicId: string;
    senderId: string;
}>;

type RtcTopologyWorkEnvelope<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId: string;
    data: T;
}>;

type PersistedRtcTopologyWork =
    & (RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork)
    & Readonly<{
        [COALESCED_APP_OUTBOX_WORK_FIELD]?: CoalescedAppOutboxWorkMetadata;
    }>;

type CreateRtcTopologyWorkRuntimeOptions = Readonly<{
    service: CoalescedAppOutboxWorkService;
    outboxQueueReader: OutboxQueueReader;
    senderId: string;
    workType: string;
    topicId: string;
    wake?: () => void;
    now?: () => number;
}>;

export function createRtcTopologyOutboxPublisher(options: Readonly<{
    outboxQueueReader: OutboxQueueReader;
    senderId?: string;
    topicId?: string;
    wake?: () => void;
    now?: () => number;
}>): RtcTopologyWorkRuntime {
    const senderId = options.senderId ?? 'rallar-server';
    return createRtcTopologyWorkRuntime({
        service: new CoalescedAppOutboxWorkService(
            options.outboxQueueReader,
            toAppQueueCreatedBy(senderId),
            options.now,
        ),
        outboxQueueReader: options.outboxQueueReader,
        senderId,
        workType: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: options.topicId ?? APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        wake: options.wake,
        now: options.now,
    });
}

export function createRtcTopologyWorkHandler(options: Readonly<{
    runtime: RtcTopologyWorkRuntime;
    database: PSqlSql;
    topologyManagement: GroupTopologyManagementService;
    executionRepository: RtcTopologyExecutionRepository;
    publicationFanout: RtcTopologyPublicationFanout;
    onInactiveOverlay?: (overlayId: string) => void;
    wakeQueue?: () => void;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
}>): OnMessageCallback {
    return {
        onMessage: async (message: ALMessage, entry: ResourceEntry) => {
            const workEnvelope = readRtcTopologyWorkEnvelope(
                message,
                options.runtime.workType,
            );
            const work = workEnvelope.data;
            const workId = toRtcTopologyExecutionId(workEnvelope);
            const attemptCount = entry.dequeueAudit.attempts;
            const read = await options.executionRepository.readTopologyMutation(
                work.groupSnapshot.group,
                workId,
            );
            if (read.publicationClaim) {
                const replayInput = {
                    read,
                    candidate: null,
                    publication: null,
                    facts: {
                        publicationExpireAtTimestamp: null,
                        commandHash: null,
                        attemptCount: null,
                    },
                } as const;
                const computed = computeTopologyMutation(replayInput);
                validateTopologyMutation({ ...replayInput, computed });
                if (computed.outcome !== 'loaded') {
                    throw new RuntimeStateWriteConflictError();
                }
                await runInTransaction(options.database, async (transaction) => {
                    await writeRtcTopologyPublicationOutbox(
                        transaction,
                        computed.publication,
                    );
                    await finishRtcTopologyReservation(transaction, entry);
                });
                options.topologyManagement.recordTopologyPublication(true);
                options.wakeQueue?.();
                return;
            }

            const authority = await options.topologyManagement
                .readTopologyPlanningAuthority(
                    work.groupSnapshot.group,
                    fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
                    work.groupSnapshot,
                );
            const group = authority.group;
            if (
                work.kind === 'group-revision' &&
                work.sourceGroupStateRevision < readGroupStateRevision(group)
            ) {
                await finishRtcTopologyWork(options.database, entry);
                return;
            }
            const computedTopology = options.topologyManagement
                .computeTopologyFromAuthority(authority, read.snapshot?.value);
            const publicationExpireAtTimestamp = work.publish
                ? options.executionRepository.publicationExpireAtTimestamp()
                : null;
            const publicationFacts: RtcOverlayTopologyMessageFacts | null =
                publicationExpireAtTimestamp === null
                    ? null
                    : {
                        workId,
                        createdAtEpochMs: work.requestedAtEpochMs,
                        expiresAtEpochMs: publicationExpireAtTimestamp,
                    };
            const publication = publicationFacts
                ? toTopologyPublication(
                    workEnvelope,
                    group,
                    computedTopology.snapshot,
                    publicationFacts,
                )
                : null;
            const facts = publication && publicationFacts ? {
                publicationExpireAtTimestamp:
                    publicationFacts.expiresAtEpochMs,
                commandHash: await hashRtcTopologyExecutionCommand(publication),
                attemptCount,
            } : {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            } as const;
            const computed = computeTopologyMutation({
                read,
                candidate: computedTopology.snapshot,
                publication,
                facts,
            });
            validateTopologyMutation({
                read,
                candidate: computedTopology.snapshot,
                publication,
                facts,
                computed,
            });
            if (computed.outcome === 'retry') {
                throw new RuntimeStateWriteConflictError();
            }
            if (computed.outcome === 'loaded') {
                throw new TypeError(
                    'RTC topology publication claim appeared on a claim-miss path',
                );
            }
            if (computed.outcome === 'superseded') {
                await finishRtcTopologyWork(options.database, entry);
                options.topologyManagement.observeCommittedTopology(
                    group,
                    computed.current,
                );
                return;
            }
            await runInTransaction(options.database, async (transaction) => {
                await options.executionRepository.writeTopologyMutation(
                    transaction,
                    computed,
                );
                if (publication) {
                    await writeRtcTopologyPublicationOutbox(transaction, publication);
                }
                await finishRtcTopologyReservation(transaction, entry);
            });
            options.topologyManagement.observeCommittedTopology(
                group,
                computed.snapshotGuard.candidate,
            );
            if (computed.snapshotGuard.candidate.state === 'removed') {
                options.onInactiveOverlay?.(work.overlayId);
            }
            if (publication) {
                options.topologyManagement.recordTopologyPublication(true);
                options.wakeQueue?.();
            }
        },
    };
}

async function finishRtcTopologyWork(
    database: PSqlSql,
    entry: ResourceEntry,
): Promise<void> {
    await runInTransaction(database, async (transaction) => {
        await finishRtcTopologyReservation(transaction, entry);
    });
}

async function finishRtcTopologyReservation(
    transaction: Parameters<Parameters<typeof runInTransaction>[1]>[0],
    entry: ResourceEntry,
): Promise<void> {
    const finished = await new ResourceInboxRepository(transaction).finishReserved(
        entry.key,
        entry.dequeueAudit.attempts,
        EntityStatus.COMPLETED,
        new Date(),
    );
    if (!finished) {
        throw new RuntimeStateWriteConflictError();
    }
}

export class RtcTopologyExecutionConflictError extends Error {
    readonly status = 503;
    readonly code = 'rtc-topology-execution-conflict';

    constructor(readonly workId: string) {
        super(`RTC topology predecessor changed before the queued attempt committed: ${workId}`);
        this.name = 'RtcTopologyExecutionConflictError';
    }
}

function createRtcTopologyWorkRuntime(
    options: CreateRtcTopologyWorkRuntimeOptions,
): RtcTopologyWorkRuntime {
    const now = options.now ?? (() => Date.now());

    const enqueueRtt = async (
        group: GroupSnapshot,
        rtt: RttMeasurementInfo,
        debounceMs: number,
    ): Promise<void> => {
        const overlayId = toScopedOverlayId(group.group);
        const requestedGroupStateRevision = readGroupStateRevision(group);
        const requestedAtEpochMs = now();
        const input = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: overlayId,
            contextId: toRtcTopologyQueueContextId(group.group),
            data: {
                kind: 'rtt-refresh',
                overlayId,
                groupSnapshot: group,
                requestedGroupStateRevision,
                requestedRttVersion: rtt.version,
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true,
            } satisfies RtcTopologyRttRefreshWork,
            reason: 'rtt',
            requestedAtEpochMs,
            dueAtEpochMs: requestedAtEpochMs + debounceMs,
            merge: mergeRtcTopologyRttWork,
        } as const;
        const result = await options.service.enqueue(input);

        if (result.blockedByReserved) {
            await options.service.enqueue({
                ...input,
                resourceId: toRtcTopologyRttSuccessorResourceId(
                    overlayId,
                    requestedGroupStateRevision,
                    rtt,
                ),
            });
        }
        options.wake?.();
    };

    const enqueueGroupSnapshot = async (
        group: GroupSnapshot,
        deliveryId?: string,
    ): Promise<RtcTopologyGroupEnqueueResult> => {
        const overlayId = toScopedOverlayId(group.group);
        const sourceGroupStateRevision = readGroupStateRevision(group);
        const requestedAtEpochMs = now();
        const envelope: RtcTopologyWorkEnvelope<RtcTopologyGroupRevisionWork> = {
            type: options.workType,
            topicId: options.topicId,
            resourceId: deliveryId ??
                toRtcTopologyGroupRevisionResourceId(
                    overlayId,
                    sourceGroupStateRevision,
                ),
            contextId: toRtcTopologyQueueContextId(group.group),
            senderId: toAppQueueCreatedBy(options.senderId),
            data: {
                kind: 'group-revision',
                overlayId,
                groupSnapshot: group,
                sourceGroupStateRevision,
                requestedAtEpochMs,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true,
            },
        };
        const key = toAppQueueKey(envelope);
        const winner = await options.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                toAppQueueCreatedBy(options.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                options.workType,
                envelope,
            ),
        );
        options.wake?.();
        const winnerMessage = parsePersistedRtcTopologyALMessage(winner.resource);
        const winnerEnvelope = readRtcTopologyWorkEnvelope(
            winnerMessage,
            options.workType,
        );
        if (winnerEnvelope.data.kind !== 'group-revision') {
            throw new TypeError(
                'RTC topology group enqueue resolved non-group work',
            );
        }
        return {
            effectiveSnapshotRevision:
                winnerEnvelope.data.sourceGroupStateRevision,
        };
    };

    const publisher: RtcTopologyWorkPublisher = {
        enqueueForGroupSnapshot: async (group) => {
            await enqueueGroupSnapshot(group);
        },
        enqueueForStateMutation: enqueueGroupSnapshot,
        enqueueForRtt: enqueueRtt,
        enqueueForRttGroups: async (rtt, groups, debounceMs) => {
            for (const group of groups) {
                await enqueueRtt(group, rtt, debounceMs);
            }
        },
    };

    return {
        service: options.service,
        outboxQueueReader: options.outboxQueueReader,
        publisher,
        workType: options.workType,
        topicId: options.topicId,
        senderId: options.senderId,
    };
}

function readRtcTopologyWorkEnvelope(
    message: ALMessage,
    expectedWorkType: string,
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
    validatePersistedALMessage(message);
    const value: unknown = JSON.parse(message.payload.resource);
    validatePersistedRtcTopologyWorkEnvelope(value, message, expectedWorkType);
    return value;
}

function toRtcTopologyExecutionId(
    envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>,
): string {
    const metadata = envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
    return [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        metadata?.generation ?? 0,
    ].join(':');
}

function parsePersistedRtcTopologyALMessage(serialized: string): ALMessage {
    const value: unknown = JSON.parse(serialized);
    validatePersistedALMessage(value);
    return value;
}

function validatePersistedRtcTopologyWorkEnvelope(
    value: unknown,
    message: ALMessage,
    expectedWorkType: string,
): asserts value is RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
    const envelope = requireWorkRecord(value, 'RTC topology work envelope');
    requireWorkKeys(envelope, [
        'type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data',
    ], [
        'type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data',
    ], 'RTC topology work envelope');
    requireWorkString(envelope.type, 'RTC topology work type');
    requireWorkString(envelope.topicId, 'RTC topology work topicId');
    requireWorkString(envelope.resourceId, 'RTC topology work resourceId');
    requireWorkString(envelope.contextId, 'RTC topology work contextId');
    requireWorkString(envelope.senderId, 'RTC topology work senderId');
    const queueKey = toAppQueueKey({
        topicId: envelope.topicId,
        resourceId: envelope.resourceId,
        contextId: envelope.contextId,
    });
    if (
        envelope.senderId !== message.id.senderId ||
        envelope.type !== expectedWorkType ||
        message.payload.typeId !== expectedWorkType ||
        envelope.type !== message.payload.typeId ||
        queueKey.topicId !== message.route.topicId ||
        queueKey.resourceId !== message.route.resourceId ||
        queueKey.contextId !== message.route.contextId
    ) throw new TypeError('RTC topology work envelope differs from its AL route');
    const work = requireWorkRecord(envelope.data, 'RTC topology work data');
    const common = [
        'kind', 'overlayId', 'groupSnapshot', 'requestedAtEpochMs',
        'requestOptions', 'publish',
    ];
    const variant = work.kind === 'group-revision'
        ? ['sourceGroupStateRevision']
        : work.kind === 'rtt-refresh'
        ? ['requestedGroupStateRevision', 'requestedRttVersion']
        : null;
    if (!variant) throw new TypeError('RTC topology work kind is invalid');
    const allowed = [...common, ...variant, COALESCED_APP_OUTBOX_WORK_FIELD];
    requireWorkKeys(work, [...common, ...variant], allowed, 'RTC topology work data');
    requireWorkString(work.overlayId, 'RTC topology work overlayId');
    requireWorkInteger(work.requestedAtEpochMs, 'RTC topology work requestedAtEpochMs');
    try {
        readCanonicalGroupTopologyConfigPatch(work.requestOptions);
    } catch {
        throw new TypeError('RTC topology work request options are invalid');
    }
    if (typeof work.publish !== 'boolean') {
        throw new TypeError('RTC topology work request options are invalid');
    }
    validateAuthoritativeGroupSnapshot(work.groupSnapshot);
    if (work.overlayId !== toScopedOverlayId(work.groupSnapshot.group)) {
        throw new TypeError('RTC topology work overlayId differs from group scope');
    }
    if (envelope.contextId !== toRtcTopologyQueueContextId(work.groupSnapshot.group)) {
        throw new TypeError('RTC topology work context differs from group scope');
    }
    const stateRevision = readGroupStateRevision(work.groupSnapshot);
    if (work.kind === 'group-revision') {
        requireWorkInteger(
            work.sourceGroupStateRevision,
            'RTC topology work sourceGroupStateRevision',
        );
        if (work.sourceGroupStateRevision !== stateRevision) {
            throw new TypeError('RTC topology work source revision differs from snapshot');
        }
    } else {
        requireWorkInteger(
            work.requestedGroupStateRevision,
            'RTC topology work requestedGroupStateRevision',
        );
        requireWorkInteger(work.requestedRttVersion, 'RTC topology work requestedRttVersion');
        if (work.requestedGroupStateRevision !== stateRevision) {
            throw new TypeError('RTC topology RTT work revision differs from snapshot');
        }
    }
    if (Object.hasOwn(work, COALESCED_APP_OUTBOX_WORK_FIELD)) {
        validateCoalescedWorkMetadata(work[COALESCED_APP_OUTBOX_WORK_FIELD]);
    } else if (work.kind === 'rtt-refresh') {
        throw new TypeError('RTC topology RTT work coalescing metadata is required');
    }
}

function validateCoalescedWorkMetadata(value: unknown): void {
    const metadata = requireWorkRecord(value, 'RTC topology coalescing metadata');
    requireWorkKeys(metadata, [
        'generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons',
    ], [
        'generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons',
    ], 'RTC topology coalescing metadata');
    requireWorkInteger(metadata.generation, 'RTC topology coalescing generation');
    requireWorkInteger(
        metadata.requestedAtEpochMs,
        'RTC topology coalescing requestedAtEpochMs',
    );
    requireWorkInteger(metadata.dueAtEpochMs, 'RTC topology coalescing dueAtEpochMs');
    if (!Array.isArray(metadata.reasons) ||
        metadata.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)) {
        throw new TypeError('RTC topology coalescing reasons are invalid');
    }
}

function requireWorkRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isWorkRecord(value)) throw new TypeError(`${label} must be an object`);
    return value;
}

function isWorkRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireWorkKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    allowed: readonly string[],
    label: string,
): void {
    const missing = required.find((key) => !Object.hasOwn(value, key));
    if (missing) throw new TypeError(`${label} is missing ${missing}`);
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unexpected) throw new TypeError(`${label} has unexpected ${unexpected}`);
}

function requireWorkString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireWorkInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function toTopologyPublication(
    envelope: RtcTopologyWorkEnvelope<
        RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork
    >,
    group: GroupSnapshot,
    snapshot: Parameters<typeof materializeRtcOverlayTopologyBroadcastMessage>[1],
    facts: RtcOverlayTopologyMessageFacts,
): RtcTopologyPublication {
    const workId = toRtcTopologyExecutionId(envelope);
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision:
                snapshot.sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version,
        }),
        workId,
        groupRef: canonicalGroupRef(group.group),
        sourceGroupStateCausalRevision:
            snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: group.group.snapshotVersion,
        recipientSessionIds: snapshot.activeSessionIds,
        message: materializeRtcOverlayTopologyBroadcastMessage(
            group,
            snapshot,
            facts,
        ),
        createdAtEpochMs: facts.createdAtEpochMs,
    };
}

function mergeRtcTopologyRttWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork>,
): CoalescedAppOutboxWorkData<RtcTopologyRttRefreshWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    const selectedGroup = existing.requestedGroupStateRevision >
            incoming.requestedGroupStateRevision
        ? existing
        : incoming;
    return {
        ...incoming,
        groupSnapshot: selectedGroup.groupSnapshot,
        requestedGroupStateRevision: Math.max(
            existing.requestedGroupStateRevision,
            incoming.requestedGroupStateRevision,
        ),
        requestedRttVersion: Math.max(
            existing.requestedRttVersion,
            incoming.requestedRttVersion,
        ),
        requestedAtEpochMs: Math.max(
            existing.requestedAtEpochMs,
            incoming.requestedAtEpochMs,
        ),
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            dueAtEpochMs: Math.max(previous.dueAtEpochMs, next.dueAtEpochMs),
            reasons: uniqueStrings([...previous.reasons, ...next.reasons]),
        },
    };
}

function toRtcTopologyGroupRevisionResourceId(
    overlayId: string,
    stateRevision: number,
): string {
    return `${overlayId}:group-revision:${stateRevision}`;
}

function toRtcTopologyRttSuccessorResourceId(
    overlayId: string,
    stateRevision: number,
    rtt: RttMeasurementInfo,
): string {
    const pair = toCanonicalRtcTopologyPairIdentity(
        rtt.sessionIdFrom,
        rtt.sessionIdTo,
    );
    return `${overlayId}:rtt:${stateRevision}:pair=${encodeURIComponent(pair)}:${rtt.version}`;
}

function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
    return groupStateGroupStorageKey(groupRef);
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
