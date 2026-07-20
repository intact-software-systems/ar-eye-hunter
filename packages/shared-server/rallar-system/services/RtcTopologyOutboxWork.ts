import {
    type ALMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
import {
    readGroupStateRevision,
} from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { RtcTopologyPublicationFanout } from '../pubsub/RtcTopologyClusterTransport.ts';
import {
    hashRtcTopologyExecutionCommand,
    type RtcTopologyPublication,
    toRtcTopologyPublicationId,
} from '../repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyExecutionRepository } from '../repositories/RtcTopologyExecutionRepository.ts';
import type { RtcRttRepository } from '../repositories/RtcRttRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    toCanonicalRtcTopologyPairIdentity,
} from '../rtc-topology-identifiers.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
} from './rtc-topology-mutations.ts';
import { waitForRuntimeStateWriteRetry } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';
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

export const APP_OUTBOX_RTC_TOPOLOGY_TOPIC = 'app-outbox.rtc-topology';

export type RtcTopologyGroupRevisionWork = Readonly<{
    kind: 'group-revision';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    sourceGroupStateRevision: number;
    requestedAtEpochMs: number;
}>;

export type RtcTopologyRttRefreshWork = Readonly<{
    kind: 'rtt-refresh';
    overlayId: string;
    groupSnapshot: GroupSnapshot;
    requestedGroupStateRevision: number;
    requestedRttVersion: number;
    requestedAtEpochMs: number;
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
    topologyManagement: GroupTopologyManagementService;
    executionRepository: RtcTopologyExecutionRepository;
    publicationFanout: RtcTopologyPublicationFanout;
    onInactiveOverlay?: (overlayId: string) => void;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
}>): OnMessageCallback {
    return {
        onMessage: async (message: ALMessage, _entry: ResourceEntry) => {
            const workEnvelope = readRtcTopologyWorkEnvelope(
                message,
                options.runtime.workType,
            );
            const work = workEnvelope.data;
            const workId = toRtcTopologyExecutionId(workEnvelope);
            const publicationFacts: RtcOverlayTopologyMessageFacts = {
                workId,
                createdAtEpochMs: work.requestedAtEpochMs,
            };
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const backoffMs = await waitForRuntimeStateWriteRetry(
                    attempt as 0 | 1 | 2,
                    { sleep: options.sleep },
                );
                const readStarted = performance.now();
                const read = await options.executionRepository
                    .readTopologyMutation(work.groupSnapshot.group, workId);
                if (read.publicationClaim) {
                    recordTopologyExecutionPhase(
                        options,
                        workId,
                        work.groupSnapshot.group,
                        'read',
                        readStarted,
                        attempt,
                        backoffMs,
                    );
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
                    const computeStarted = performance.now();
                    const computed = computeTopologyMutation(replayInput);
                    recordTopologyExecutionPhase(
                        options,
                        workId,
                        work.groupSnapshot.group,
                        'compute',
                        computeStarted,
                        attempt,
                        backoffMs,
                    );
                    const validateStarted = performance.now();
                    validateTopologyMutation({ ...replayInput, computed });
                    recordTopologyExecutionPhase(
                        options,
                        workId,
                        work.groupSnapshot.group,
                        'validate',
                        validateStarted,
                        attempt,
                        backoffMs,
                    );
                    if (computed.outcome === 'retry') continue;
                    if (computed.outcome !== 'loaded') {
                        throw new TypeError(
                            'RTC topology claimed replay has an invalid outcome',
                        );
                    }
                    await options.publicationFanout.publish(computed.publication);
                    options.topologyManagement.recordTopologyPublication(true);
                    return;
                }
                const authority = await options.topologyManagement
                    .readTopologyPlanningAuthority(
                        work.groupSnapshot.group,
                        undefined,
                        work.groupSnapshot,
                    );
                const group = authority.group;
                if (
                    work.kind === 'group-revision' &&
                    work.sourceGroupStateRevision < readGroupStateRevision(group)
                ) {
                    return;
                }
                const planned = options.topologyManagement
                    .planTopologyFromAuthority(authority, read.snapshot?.value);
                recordTopologyExecutionPhase(
                    options,
                    workId,
                    group.group,
                    'read',
                    readStarted,
                    attempt,
                    backoffMs,
                );
                const computeStarted = performance.now();
                const publication = toTopologyPublication(
                    workEnvelope,
                    group,
                    planned.snapshot,
                    publicationFacts,
                );
                const facts = {
                    publicationExpireAtTimestamp: options.executionRepository
                        .publicationExpireAtTimestamp(),
                    commandHash: await hashRtcTopologyExecutionCommand(publication),
                    attemptCount: attempt + 1,
                };
                const computed = computeTopologyMutation({
                    read,
                    candidate: planned.snapshot,
                    publication,
                    facts,
                });
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'compute', computeStarted,
                    attempt, backoffMs,
                );
                const validateStarted = performance.now();
                validateTopologyMutation({
                    read,
                    candidate: planned.snapshot,
                    publication,
                    facts,
                    computed,
                });
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'validate', validateStarted,
                    attempt, backoffMs,
                );
                if (computed.outcome === 'superseded') {
                    options.topologyManagement.observeCommittedTopology(
                        group,
                        computed.current,
                    );
                    return;
                }
                if (computed.outcome === 'retry') {
                    recordRallarTiming(options.timing, {
                        component: 'rtc-topology-execution-service',
                        operation: 'mutation.conflict',
                        serviceId: options.serviceId,
                        requestId: workId,
                        ...canonicalGroupRef(group.group),
                        details: {
                            attempt,
                            backoffMs,
                            conflict: true,
                            reason: computed.reason,
                        },
                    }, 'ok', 0);
                    continue;
                }
                if (computed.outcome === 'loaded') {
                    throw new TypeError(
                        'RTC topology publication claim appeared on a claim-miss path',
                    );
                }
                const writeStarted = performance.now();
                const transactionStarted = performance.now();
                const written = await options.executionRepository
                    .writeTopologyMutation(computed);
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'transaction', transactionStarted,
                    attempt, backoffMs,
                );
                recordTopologyExecutionPhase(
                    options, workId, group.group, 'write', writeStarted,
                    attempt, backoffMs,
                );
                if (written === 'conflict') {
                    recordRallarTiming(options.timing, {
                        component: 'rtc-topology-execution-service',
                        operation: 'mutation.conflict',
                        serviceId: options.serviceId,
                        requestId: workId,
                        ...canonicalGroupRef(group.group),
                        details: { attempt, backoffMs, conflict: true },
                    }, 'ok', 0);
                    continue;
                }
                options.topologyManagement.observeCommittedTopology(
                    group,
                    computed.snapshotGuard.candidate,
                );
                if (computed.snapshotGuard.candidate.state === 'removed') {
                    options.onInactiveOverlay?.(work.overlayId);
                }
                await options.publicationFanout.publish(publication!);
                options.topologyManagement.recordTopologyPublication(true);
                return;
            }

            throw new RtcTopologyExecutionConflictError(workId);
        },
    };
}

export class RtcTopologyExecutionConflictError extends Error {
    readonly status = 503;
    readonly code = 'rtc-topology-execution-conflict';

    constructor(readonly workId: string) {
        super(`RTC topology predecessor changed during three execution attempts: ${workId}`);
        this.name = 'RtcTopologyExecutionConflictError';
    }
}

export async function drainRtcRttRecomputeOutbox(input: Readonly<{
    repository: RtcRttRepository;
    publisher: RtcTopologyWorkPublisher;
    debounceMs: number;
    now?: () => number;
}>): Promise<number> {
    let delivered = 0;
    for (const entry of await input.repository.listRecomputeIntentEntries()) {
        if (entry.value.delivery.state === 'delivered') continue;
        const observedAtEpochMs = input.now?.() ?? Date.now();
        if (
            !Number.isSafeInteger(observedAtEpochMs) ||
            observedAtEpochMs < entry.value.createdAtEpochMs ||
            observedAtEpochMs > entry.entry.expireAtTimestamp
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                entry.entry.key,
                `RTC RTT recompute delivery time ${observedAtEpochMs} is outside retained family ${entry.value.createdAtEpochMs}..${entry.entry.expireAtTimestamp}`,
            );
        }
        await input.publisher.enqueueForRtt(
            entry.value.groupSnapshot,
            entry.value.rtt,
            input.debounceMs,
        );
        const deliveredAtEpochMs = input.now?.() ?? Date.now();
        if (
            !Number.isSafeInteger(deliveredAtEpochMs) ||
            deliveredAtEpochMs < entry.value.createdAtEpochMs ||
            deliveredAtEpochMs > entry.entry.expireAtTimestamp
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                entry.entry.key,
                `RTC RTT recompute delivery time ${deliveredAtEpochMs} is outside retained family ${entry.value.createdAtEpochMs}..${entry.entry.expireAtTimestamp}`,
            );
        }
        const marked = await input.repository.markRecomputeIntentDelivered(
            entry,
            deliveredAtEpochMs,
        );
        if (marked.status === 'accepted') delivered += 1;
    }
    return delivered;
}

export const DEFAULT_RTC_RTT_RECOMPUTE_OUTBOX_INTERVAL_MS = 1_000;
export const DEFAULT_RTC_RTT_RECOMPUTE_OUTBOX_RETRY_DELAYS_MS = [
    2,
    8,
    32,
    128,
    512,
    1_000,
] as const;

export type RtcRttRecomputeOutboxWorkerFailure = Readonly<{
    name: string;
    message: string;
    code?: string;
}>;

export type RtcRttRecomputeOutboxWorker = Readonly<{
    firstRun: Promise<number>;
    wake(): void;
    stop(): void;
}>;

export function initRtcRttRecomputeOutboxWorker(input: Readonly<{
    repository: RtcRttRepository;
    publisher: RtcTopologyWorkPublisher;
    debounceMs: number;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    now?: () => number;
    schedule?: (
        callback: () => void | Promise<void>,
        delayMs: number,
    ) => unknown;
    cancel?: (handle: unknown) => void;
    onError?: (failure: RtcRttRecomputeOutboxWorkerFailure) => void;
}>): RtcRttRecomputeOutboxWorker {
    const intervalMs = input.intervalMs ??
        DEFAULT_RTC_RTT_RECOMPUTE_OUTBOX_INTERVAL_MS;
    const retryDelaysMs = input.retryDelaysMs ??
        DEFAULT_RTC_RTT_RECOMPUTE_OUTBOX_RETRY_DELAYS_MS;
    validateWorkerDelays(intervalMs, retryDelaysMs);
    const schedule = input.schedule ?? ((
        callback: () => void | Promise<void>,
        delayMs: number,
    ) => {
        const handle = setTimeout(() => void callback(), delayMs);
        (handle as { unref?: () => void }).unref?.();
        return handle;
    });
    const cancel = input.cancel ?? ((handle: unknown) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    let stopped = false;
    let running = false;
    let wakeRequested = false;
    let scheduledHandle: unknown;
    let failureCount = 0;
    let settleFirstRun!: (count: number) => void;
    let rejectFirstRun!: (error: unknown) => void;
    let firstRunSettled = false;
    const firstRun = new Promise<number>((resolve, reject) => {
        settleFirstRun = resolve;
        rejectFirstRun = reject;
    });

    const cancelScheduled = (): void => {
        if (scheduledHandle === undefined) return;
        cancel(scheduledHandle);
        scheduledHandle = undefined;
    };
    const scheduleRun = (delayMs: number): void => {
        if (stopped) return;
        cancelScheduled();
        let handle: unknown;
        handle = schedule(async () => {
            if (scheduledHandle === handle) scheduledHandle = undefined;
            await run();
        }, delayMs);
        scheduledHandle = handle;
        (handle as { unref?: () => void }).unref?.();
    };
    const run = async (): Promise<void> => {
        if (stopped) return;
        if (running) {
            wakeRequested = true;
            return;
        }
        running = true;
        let failed = false;
        try {
            const delivered = await drainRtcRttRecomputeOutbox(input);
            failureCount = 0;
            if (!firstRunSettled) {
                firstRunSettled = true;
                settleFirstRun(delivered);
            }
        } catch (error) {
            failed = true;
            try {
                input.onError?.(sanitizeWorkerFailure(error));
            } catch {
                // Observability must not disable autonomous durable delivery.
            }
            if (!firstRunSettled) {
                firstRunSettled = true;
                rejectFirstRun(error);
            }
            failureCount += 1;
        } finally {
            running = false;
            if (stopped) return;
            if (wakeRequested) {
                wakeRequested = false;
                scheduleRun(0);
            } else if (failed) {
                scheduleRun(retryDelaysMs[
                    Math.min(failureCount - 1, retryDelaysMs.length - 1)
                ]!);
            } else {
                scheduleRun(intervalMs);
            }
        }
    };

    void run();
    return {
        firstRun,
        wake: () => {
            if (stopped) return;
            if (running) {
                wakeRequested = true;
                return;
            }
            scheduleRun(0);
        },
        stop: () => {
            if (stopped) return;
            stopped = true;
            wakeRequested = false;
            cancelScheduled();
        },
    };
}

function validateWorkerDelays(
    intervalMs: number,
    retryDelaysMs: readonly number[],
): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new RangeError('RTC RTT recompute worker interval is invalid');
    }
    if (
        retryDelaysMs.length === 0 ||
        retryDelaysMs.some((delayMs) =>
            !Number.isSafeInteger(delayMs) || delayMs < 0
        )
    ) {
        throw new RangeError('RTC RTT recompute worker retry schedule is invalid');
    }
}

function sanitizeWorkerFailure(
    error: unknown,
): RtcRttRecomputeOutboxWorkerFailure {
    const rawName = error instanceof Error ? error.name : undefined;
    const name = typeof rawName === 'string' &&
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
        ? rawName
        : 'Error';
    const code = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
    return {
        name,
        message: 'RTC RTT recompute outbox delivery failed',
        ...(typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code)
            ? { code }
            : {}),
    };
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

function recordTopologyExecutionPhase(
    options: Readonly<{
        timing?: RallarTimingSink;
        serviceId?: string;
    }>,
    workId: string,
    groupRef: GroupRef,
    phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
    started: number,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(options.timing, {
        component: 'rtc-topology-execution-service',
        operation: `mutation.${phase}`,
        serviceId: options.serviceId,
        requestId: workId,
        ...canonicalGroupRef(groupRef),
        details: { attempt, backoffMs },
    }, 'ok', performance.now() - started);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values)];
}
