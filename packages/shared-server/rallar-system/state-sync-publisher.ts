import { Temporal } from '@js-temporal/polyfill';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type {
    ClientEvent,
    ClientPrincipalRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import {
    validateAuthoritativeClientEvent,
    validateAuthoritativeClientSnapshot,
    validateAuthoritativeGroupEvent,
    validateAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { PSqlTransactionSql } from '../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    recordRallarTiming,
    type RallarTimingSink,
} from './services/timing.ts';
import {
    toAppQueueCreatedBy,
    toAppQueueKey,
} from './services/app-inbox-queue-key.ts';

export type StateSyncAudience = Readonly<{
    kind: 'principal' | 'group';
    applicationId: string;
    workspaceId: string;
    resourceId: string;
}>;

export type ComputedClientStateSyncEffect =
    | Readonly<{
        effectKind: 'principal-state';
        payloadKind: 'snapshot';
        payload: ClientSnapshot;
    }>
    | Readonly<{
        effectKind: 'principal-state';
        payloadKind: 'event';
        payload: ClientEvent;
    }>;

export type ComputedGroupStateSyncEffect =
    | Readonly<{
        effectKind: 'member-state' | 'scope-directory';
        payloadKind: 'snapshot';
        payload: GroupSnapshot;
    }>
    | Readonly<{
        effectKind: 'member-state';
        payloadKind: 'event';
        payload: GroupEvent;
    }>;

export type ComputedClientStateSync = Readonly<{
    commandId: string;
    aggregateRef: ClientPrincipalRef;
    acceptedCausalRevision: number;
    audience: StateSyncAudience;
    createdAtEpochMs: number;
    expireAtEpochMs: number;
    effects: readonly ComputedClientStateSyncEffect[];
}>;

export type ComputedGroupStateSync = Readonly<{
    commandId: string;
    aggregateRef: GroupRef;
    acceptedCausalRevision: GroupStateCausalRevision;
    audience: StateSyncAudience;
    createdAtEpochMs: number;
    expireAtEpochMs: number;
    effects: readonly ComputedGroupStateSyncEffect[];
}>;

export function computeClientStateSyncEntries(
    computed: ComputedClientStateSync,
    senderId: string,
    principalAudienceScope: 'principal' | 'world',
): readonly ResourceEntry[] {
    validateComputedStateSyncFacts(computed, senderId);
    if (
        !Number.isSafeInteger(computed.acceptedCausalRevision) ||
        computed.acceptedCausalRevision < 0
    ) {
        throw new TypeError('Computed client state sync differs from accepted authority');
    }
    for (const effect of computed.effects) {
        validateClientStateSyncEffect(computed, effect);
    }
    return computed.effects.map((effect) =>
        toStateSyncEntry({
            computed,
            effect,
            senderId,
            topicId: AppTopics[effect.payloadKind === 'snapshot'
                ? 'clientStateSnapshot'
                : 'clientStateEvent'],
            sequence: computed.acceptedCausalRevision,
            epoch: 0,
            principalAudienceScope,
        })
    );
}

export function computeGroupStateSyncEntries(
    computed: ComputedGroupStateSync,
    senderId: string,
): readonly ResourceEntry[] {
    validateComputedStateSyncFacts(computed, senderId);
    if (!isValidGroupCausalRevision(computed.acceptedCausalRevision)) {
        throw new TypeError('Computed group state sync differs from accepted authority');
    }
    for (const effect of computed.effects) {
        validateGroupStateSyncEffect(computed, effect);
    }
    return computed.effects.map((effect) => {
        const topicId = effect.payloadKind === 'event'
            ? AppTopics.groupStateEvent
            : effect.effectKind === 'scope-directory'
            ? AppTopics.groupDirectorySnapshot
            : AppTopics.groupStateSnapshot;
        return toStateSyncEntry({
            computed,
            effect,
            senderId,
            topicId,
            sequence: computed.acceptedCausalRevision.presenceRevision,
            epoch: computed.acceptedCausalRevision.groupRevision,
            principalAudienceScope: 'world',
        });
    });
}

export async function writeClientStateSync(
    transaction: PSqlTransactionSql,
    computed: ComputedClientStateSync,
    write: Readonly<{
        senderId: string;
        principalAudienceScope: 'principal' | 'world';
    }>,
): Promise<readonly ResourceEntry[]> {
    const entries = computeClientStateSyncEntries(
        computed,
        write.senderId,
        write.principalAudienceScope,
    );
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

export async function writeGroupStateSync(
    transaction: PSqlTransactionSql,
    computed: ComputedGroupStateSync,
    senderId: string,
): Promise<readonly ResourceEntry[]> {
    const entries = computeGroupStateSyncEntries(computed, senderId);
    await writeStateSyncEntries(transaction, entries);
    return entries;
}

async function writeStateSyncEntries(
    transaction: PSqlTransactionSql,
    entries: readonly ResourceEntry[],
): Promise<void> {
    const repository = new ResourceInboxRepository(transaction);
    for (const entry of entries) {
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            throw new TypeError('State sync write received a non-WS_OUTBOX entry');
        }
        await repository.writeIfAbsentOrMatch(entry);
    }
}

type ComputedStateSync = ComputedClientStateSync | ComputedGroupStateSync;
type ComputedStateSyncEffect =
    | ComputedClientStateSyncEffect
    | ComputedGroupStateSyncEffect;

interface ToStateSyncEntryInput {
    readonly computed: ComputedStateSync;
    readonly effect: ComputedStateSyncEffect;
    readonly senderId: string;
    readonly topicId: string;
    readonly sequence: number;
    readonly epoch: number;
    readonly principalAudienceScope: 'principal' | 'world';
}

function toStateSyncEntry(input: ToStateSyncEntryInput): ResourceEntry {
    const { computed, effect, senderId, topicId, sequence, epoch } = input;
    const causalIdentity = typeof computed.acceptedCausalRevision === 'number'
        ? `revision=${computed.acceptedCausalRevision}`
        : `group=${computed.acceptedCausalRevision.groupRevision};presence=${computed.acceptedCausalRevision.presenceRevision}`;
    const messageId = [
        computed.commandId,
        effect.effectKind,
        effect.payloadKind,
        causalIdentity,
    ].join(':');
    const key = toAppQueueKey({
        topicId,
        resourceId: messageId,
        contextId: JSON.stringify([
            computed.audience.kind,
            computed.audience.applicationId,
            computed.audience.workspaceId,
            computed.audience.resourceId,
        ]),
    });
    const isGroup = computed.audience.kind === 'group';
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId,
        },
        route: key,
        targets: isGroup
            ? {
                mode: 'broadcast',
                scope: 'room',
                groupRef: {
                    applicationId: computed.audience.applicationId,
                    workspaceId: computed.audience.workspaceId,
                    groupId: computed.audience.resourceId,
                },
            }
            : input.principalAudienceScope === 'principal'
            ? {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: computed.audience.applicationId,
                    workspaceId: computed.audience.workspaceId,
                    principalId: computed.audience.resourceId,
                },
            }
            : {
                mode: 'broadcast',
                scope: 'world',
            },
        constraints: {
            expiresAtMs: computed.expireAtEpochMs,
        },
        ordering: {
            orderingKey: key.contextId,
            epoch,
            seq: sequence,
        },
        delivery: {
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'none',
        },
        payload: {
            typeId: topicId,
            contentType: 'application/json',
            resource: JSON.stringify(effect.payload),
        },
        audit: {
            createdBy: senderId,
            createdTs: computed.createdAtEpochMs,
        },
    };
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(computed.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(senderId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                computed.expireAtEpochMs,
            ),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function validateComputedStateSyncFacts(
    computed: ComputedStateSync,
    senderId: string,
): void {
    if (
        typeof computed !== 'object' ||
        computed === null ||
        typeof computed.commandId !== 'string' ||
        computed.commandId.length === 0 ||
        typeof senderId !== 'string' ||
        senderId.length === 0 ||
        !Number.isSafeInteger(computed.createdAtEpochMs) ||
        !Number.isSafeInteger(computed.expireAtEpochMs) ||
        computed.createdAtEpochMs < 0 ||
        computed.expireAtEpochMs <= computed.createdAtEpochMs ||
        !Array.isArray(computed.effects) ||
        computed.effects.length === 0 ||
        typeof computed.aggregateRef !== 'object' ||
        computed.aggregateRef === null ||
        typeof computed.aggregateRef.applicationId !== 'string' ||
        computed.aggregateRef.applicationId.length === 0 ||
        typeof computed.aggregateRef.workspaceId !== 'string' ||
        computed.aggregateRef.workspaceId.length === 0 ||
        typeof computed.audience !== 'object' ||
        computed.audience === null ||
        !['principal', 'group'].includes(computed.audience.kind) ||
        typeof computed.audience.applicationId !== 'string' ||
        computed.audience.applicationId.length === 0 ||
        typeof computed.audience.workspaceId !== 'string' ||
        computed.audience.workspaceId.length === 0 ||
        typeof computed.audience.resourceId !== 'string' ||
        computed.audience.resourceId.length === 0 ||
        computed.audience.applicationId !== computed.aggregateRef.applicationId ||
        computed.audience.workspaceId !== computed.aggregateRef.workspaceId
    ) {
        throw new TypeError('Computed state sync facts are invalid');
    }
    if (
        ('principalId' in computed.aggregateRef &&
            (
                computed.audience.kind !== 'principal' ||
                computed.audience.resourceId !== computed.aggregateRef.principalId
            )) ||
        ('groupId' in computed.aggregateRef &&
            (
                computed.audience.kind !== 'group' ||
                computed.audience.resourceId !== computed.aggregateRef.groupId
            ))
    ) {
        throw new TypeError('Computed state sync audience differs from aggregate');
    }
}

function validateClientStateSyncEffect(
    computed: ComputedClientStateSync,
    effect: ComputedClientStateSyncEffect,
): void {
    if (
        typeof effect !== 'object' ||
        effect === null ||
        effect.effectKind !== 'principal-state'
    ) {
        throw new TypeError('Computed client state sync effect kind is invalid');
    }
    if (effect.payloadKind === 'snapshot') {
        validateAuthoritativeClientSnapshot(effect.payload, computed.aggregateRef);
        if (
            !sameClientRef(computed.aggregateRef, effect.payload) ||
            effect.payload.stateRevision !== computed.acceptedCausalRevision
        ) {
            throw new TypeError(
                'Computed client state sync snapshot differs from accepted authority',
            );
        }
        return;
    }
    if (effect.payloadKind === 'event') {
        validateAuthoritativeClientEvent(effect.payload, computed.aggregateRef);
        if (
            !sameClientRef(computed.aggregateRef, effect.payload) ||
            effect.payload.snapshotVersion !== computed.acceptedCausalRevision
        ) {
            throw new TypeError(
                'Computed client state sync event differs from accepted authority',
            );
        }
        return;
    }
    throw new TypeError('Computed client state sync payload kind is invalid');
}

function validateGroupStateSyncEffect(
    computed: ComputedGroupStateSync,
    effect: ComputedGroupStateSyncEffect,
): void {
    if (typeof effect !== 'object' || effect === null) {
        throw new TypeError('Computed group state sync effect is invalid');
    }
    if (effect.payloadKind === 'snapshot') {
        if (
            effect.effectKind !== 'member-state' &&
            effect.effectKind !== 'scope-directory'
        ) {
            throw new TypeError('Computed group state sync effect kind is invalid');
        }
        validateAuthoritativeGroupSnapshot(effect.payload, computed.aggregateRef);
    } else if (effect.payloadKind === 'event') {
        if (effect.effectKind !== 'member-state') {
            throw new TypeError('Computed group state sync effect kind is invalid');
        }
        validateAuthoritativeGroupEvent(effect.payload, computed.aggregateRef);
    } else {
        throw new TypeError('Computed group state sync payload kind is invalid');
    }
    if (
        !sameGroupRef(computed.aggregateRef, effect.payload) ||
        effect.payload.causalRevision.groupRevision !==
            computed.acceptedCausalRevision.groupRevision ||
        effect.payload.causalRevision.presenceRevision !==
            computed.acceptedCausalRevision.presenceRevision
    ) {
        throw new TypeError('Computed group state sync differs from accepted authority');
    }
}

function sameClientRef(
    ref: ClientPrincipalRef,
    value: ClientSnapshot | ClientEvent,
): boolean {
    const candidate = 'principal' in value ? value.principal : value;
    return ref.applicationId === candidate.applicationId &&
        ref.workspaceId === candidate.workspaceId &&
        ref.principalId === candidate.principalId;
}

function sameGroupRef(
    ref: GroupRef,
    value: GroupSnapshot | GroupEvent,
): boolean {
    const candidate = 'group' in value ? value.group : value;
    return ref.applicationId === candidate.applicationId &&
        ref.workspaceId === candidate.workspaceId &&
        ref.groupId === candidate.groupId;
}

function isValidGroupCausalRevision(
    revision: GroupStateCausalRevision,
): boolean {
    return Number.isSafeInteger(revision.groupRevision) &&
        revision.groupRevision >= 0 &&
        Number.isSafeInteger(revision.presenceRevision) &&
        revision.presenceRevision >= 0;
}

export type StateSyncPublisher = Readonly<{
    publishClientSnapshot(
        snapshot: ClientSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void | StateSyncSnapshotPublishResult>;
    publishClientEvent(
        event: ClientEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
    publishGroupSnapshot(
        snapshot: GroupSnapshot,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void | StateSyncSnapshotPublishResult>;
    publishGroupEvent(
        event: GroupEvent,
        senderId?: string,
        deliveryId?: string,
    ): Promise<void>;
}>;

export type StateSyncSnapshotPublishResult = Readonly<{
    effectiveSnapshotRevision: number;
}>;

export type CreateWsStateSyncPublisherOptions = Readonly<{
    serverId: string;
    timing?: RallarTimingSink;
}>;

export function createWsStateSyncPublisher(
    wsQBoxServerService: WsQueueBoxServerService,
    options: CreateWsStateSyncPublisherOptions,
): StateSyncPublisher {
    return {
        publishClientSnapshot: async (snapshot, senderId, deliveryId) => {
            const result = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.principal.principalId,
                AppTopics.clientStateSnapshot,
                snapshot.principal.principalId,
                snapshot.principal.principalId,
                snapshot,
                {
                    requireLiveRoute: hasActiveClientSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
            return readStateSyncSnapshotPublishResult(result);
        },
        publishClientEvent: async (event, senderId, deliveryId) => {
            const snapshot = clientStateSnapshotsRepository
                .findClientStateSnapshotByPrincipalId(event.principalId);
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? mutationActorSenderId(event.actor),
                AppTopics.clientStateEvent,
                event.principalId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveClientSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
        publishGroupSnapshot: async (snapshot, senderId, deliveryId) => {
            const stateResult = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    requireLiveRoute: hasActiveGroupSessions(snapshot),
                    timing: options.timing,
                    deliveryId,
                },
            );
            const directoryResult = await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? snapshot.group.groupId,
                AppTopics.groupDirectorySnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
                snapshot,
                {
                    timing: options.timing,
                    deliveryId,
                },
            );
            return combineStateSyncSnapshotPublishResults(
                readStateSyncSnapshotPublishResult(stateResult),
                readStateSyncSnapshotPublishResult(directoryResult),
            );
        },
        publishGroupEvent: async (event, senderId, deliveryId) => {
            const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(
                {
                    applicationId: event.applicationId,
                    workspaceId: event.workspaceId,
                    groupId: event.groupId,
                },
            );
            await enqueueBroadcast(
                wsQBoxServerService,
                senderId ?? mutationActorSenderId(event.actor),
                AppTopics.groupStateEvent,
                event.groupId,
                event.eventId,
                event,
                {
                    requireLiveRoute: snapshot
                        ? hasActiveGroupSessions(snapshot)
                        : false,
                    timing: options.timing,
                    deliveryId,
                },
            );
        },
    };
}

async function enqueueBroadcast<T>(
    wsQBoxServerService: WsQueueBoxServerService,
    senderId: string,
    topicId: string,
    contextId: string,
    resourceId: string,
    payload: T,
    options: Readonly<{
        requireLiveRoute?: boolean;
        timing?: RallarTimingSink;
        deliveryId?: string;
    }> = {},
): Promise<ALOutboundEnqueueResult> {
    const message = newALBroadcastMessage<T>(
        senderId,
        newALEventRoute(topicId, contextId, resourceId),
        'all',
        topicId,
        payload,
        {
            reliability: 'at-least-once',
            ack: 'none',
        },
    );
    const result = await wsQBoxServerService.enqueueOutboxIfAbsent(
        options.deliveryId
            ? {
                ...message,
                id: {
                    ...message.id,
                    msgId: toStateSyncMessageId(options.deliveryId, topicId),
                },
            }
            : message,
    );

    assertStateSyncPublishResult(result, {
        topicId,
        resourceId,
        requireLiveRoute: options.requireLiveRoute ?? false,
        timing: options.timing,
    });
    return result;
}

export function toStateSyncMessageId(
    deliveryId: string,
    topicId: string,
): string {
    return `state-sync-${fnv1a64(`${deliveryId}\u0000${topicId}`)}`;
}

function readStateSyncSnapshotPublishResult(
    result: ALOutboundEnqueueResult,
): StateSyncSnapshotPublishResult | undefined {
    // The current AL duplicate result can reconstruct entry.resource from the
    // retry candidate while retaining only the persisted winner's key. Until
    // that boundary marks winner provenance explicitly, only a fresh enqueue
    // proves that the returned resource is the effective durable payload.
    if (result.status !== 'enqueued') {
        return undefined;
    }
    const entries = result.entries.length > 0
        ? result.entries
        : result.entry
        ? [result.entry]
        : [];
    if (entries.length === 0) {
        return undefined;
    }
    const revisions = entries.map((entry) => {
        const message = JSON.parse(entry.resource) as {
            payload?: { resource?: string };
        };
        const snapshot = JSON.parse(message.payload?.resource ?? 'null') as {
            stateRevision?: unknown;
        } | null;
        const revision = snapshot?.stateRevision;
        if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
            throw new TypeError(
                'State sync durable winner has an invalid snapshot revision',
            );
        }
        return revision as number;
    });
    return {
        effectiveSnapshotRevision: Math.min(...revisions),
    };
}

function combineStateSyncSnapshotPublishResults(
    ...results: readonly (StateSyncSnapshotPublishResult | undefined)[]
): StateSyncSnapshotPublishResult | undefined {
    if (results.some((result) => result === undefined)) {
        return undefined;
    }
    return {
        effectiveSnapshotRevision: Math.min(
            ...results.map((result) => result!.effectiveSnapshotRevision),
        ),
    };
}

function assertStateSyncPublishResult(
    result: ALOutboundEnqueueResult,
    input: Readonly<{
        topicId: string;
        resourceId: string;
        requireLiveRoute: boolean;
        timing?: RallarTimingSink;
    }>,
): void {
    switch (result.status) {
        case 'enqueued':
        case 'sent-immediate':
        case 'duplicate':
            return;
        case 'skipped':
        case 'superseded':
        case 'expired':
            if (!input.requireLiveRoute) {
                return;
            }
            break;
        case 'no-route':
            if (input.requireLiveRoute) {
                console.warn('State sync publish missed live route', {
                    topicId: input.topicId,
                    resourceId: input.resourceId,
                    status: result.status,
                    reason: result.reason,
                });
                recordRallarTiming(
                    input.timing,
                    {
                        component: 'state-sync',
                        operation: 'no-route',
                        details: {
                            topicId: input.topicId,
                            resourceId: input.resourceId,
                            reason: result.reason,
                        },
                    },
                    'ok',
                    0,
                );
            }
            return;
        case 'failed':
        case 'rate-limited':
        case 'circuit-open':
            break;
    }

    throw new Error(
        `State sync publish failed for ${input.topicId}/${input.resourceId}: ${result.status}` +
        (result.reason ? ` (${result.reason})` : ''),
    );
}

function hasActiveClientSessions(snapshot: ClientSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.activeSessionCount > 0 ||
        snapshot.isOnline;
}

function hasActiveGroupSessions(snapshot: GroupSnapshot): boolean {
    return snapshot.activeSessions.length > 0 ||
        snapshot.onlineMemberCount > 0;
}

function mutationActorSenderId(actor: MutationActor): string {
    return actor.kind === 'service' ? actor.serviceId : actor.principalId;
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(36);
}
