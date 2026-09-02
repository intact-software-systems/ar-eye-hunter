import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { PendingTopologyReplan } from '@shared/api/graph-topology-management-types.ts';
import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import {
    isPreserveOnlyCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { AppOutboxType } from '../../../app-outbox/app-outbox-type.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    isMutableCoalescedStatus,
    tryReadCoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type ComputedCoalescedAppOutboxWork
} from '../../../app-outbox/coalesced-app-outbox-work-service.ts';
import { groupStateGroupStorageKey } from '../../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../mutation/rtc-topology-outbox-entry.ts';
import type { RtcTopologyGroupRevisionWork } from '../../mutation/rtc-topology-outbox-work.ts';
import type { TopologyWorkOrigin } from '../../planning/resolve-topology-plan-action.ts';
import type { TopologyReplanWindow } from '../../planning/resolve-topology-replan-window.ts';
import type { PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';

/** The timing facts a replan's due time is computed from (product decision 31, I28). */
export interface TopologyReplanTiming {
    readonly window: TopologyReplanWindow;
    /** The stored planned layout's last write, which the minimum layout age floors the due time against. */
    readonly plannedLayoutUpdatedAtEpochMs: number | null;
    readonly minimumLayoutAgeMs: number;
}

export interface RtcTopologyCoalescedGroupRevisionInput {
    readonly aggregateRef: GroupRef;
    readonly groupSnapshot: GroupSnapshot;
    readonly requestedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly timing: TopologyReplanTiming;
    readonly senderId: string;
    readonly origin: TopologyWorkOrigin;
    readonly previousEntry: ResourceEntry | null;
}

export interface ComputeTopologyReplanDueAtInput {
    readonly requestedAtEpochMs: number;
    readonly windowOpenedAtEpochMs: number;
    /** The queued row's due time this change extends; null for the first change of a series. */
    readonly previousDueAtEpochMs: number | null;
    readonly timing: TopologyReplanTiming;
}

/**
 * The extending window keeps its coalescing benefit but can no longer defer a
 * replan past the series' maximum wait (product decision 31), and a layout
 * younger than the minimum layout age is never replanned before it has aged.
 */
export function computeTopologyReplanDueAt(input: ComputeTopologyReplanDueAtInput): number {
    const { timing } = input;
    const extended = Math.max(
        input.previousDueAtEpochMs ?? 0,
        input.requestedAtEpochMs + timing.window.debounceMs
    );
    const bounded = timing.window.maxWaitMs === null
        ? extended
        : Math.min(extended, input.windowOpenedAtEpochMs + timing.window.maxWaitMs);
    return timing.plannedLayoutUpdatedAtEpochMs === null
        ? bounded
        : Math.max(bounded, timing.plannedLayoutUpdatedAtEpochMs + timing.minimumLayoutAgeMs);
}

export function toRtcTopologyCoalescedGroupRevisionResourceId(overlayId: string): string {
    return `${overlayId}:group-revision`;
}

export function computeCoalescedRtcTopologyGroupRevisionWork(
    input: RtcTopologyCoalescedGroupRevisionInput
): ComputedCoalescedAppOutboxWork {
    assertCoalescedGroupRevisionInput(input);
    const overlayId = toScopedOverlayId(input.aggregateRef);
    const incoming: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> = {
        kind: 'group-revision',
        overlayId,
        groupSnapshot: input.groupSnapshot,
        sourceGroupStateCausalRevision: readGroupCausalRevision(input.groupSnapshot),
        requestedAtEpochMs: input.requestedAtEpochMs,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        origin: input.origin,
        publish: true,
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            generation: 1,
            requestedAtEpochMs: input.requestedAtEpochMs,
            windowOpenedAtEpochMs: input.requestedAtEpochMs,
            dueAtEpochMs: computeTopologyReplanDueAt({
                requestedAtEpochMs: input.requestedAtEpochMs,
                windowOpenedAtEpochMs: input.requestedAtEpochMs,
                previousDueAtEpochMs: null,
                timing: input.timing
            }),
            reasons: ['group-revision']
        }
    };
    const successorEntry = toCoalescedGroupRevisionEntry({
        input,
        resourceId: toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
            overlayId,
            incoming.sourceGroupStateCausalRevision
        ),
        data: incoming,
        dequeueAudit: { attempts: 0 },
        entryAudit: null,
        messageIdentity: null
    });
    if (input.previousEntry === null) {
        return {
            expectedEntry: null,
            entry: toCoalescedGroupRevisionEntry({
                input,
                resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(overlayId),
                data: incoming,
                dequeueAudit: { attempts: 0 },
                entryAudit: null,
                messageIdentity: null
            }),
            successorEntry
        };
    }
    const previous = readPreviousCoalescedGroupRevisionEnvelope(input.previousEntry);
    const previousGeneration = previous.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation;
    const merged = isMutableCoalescedStatus(input.previousEntry.status)
        ? mergeRtcTopologyGroupRevisionWork(previous.data, incoming, input.timing)
        : incoming;
    const nextData: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> = {
        ...merged,
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...merged[COALESCED_APP_OUTBOX_WORK_FIELD],
            generation: previousGeneration + 1,
            requestedAtEpochMs: input.requestedAtEpochMs
        }
    };
    const carriesPreviousLifecycle = isMutableCoalescedStatus(input.previousEntry.status);
    return {
        expectedEntry: input.previousEntry,
        entry: toCoalescedGroupRevisionEntry({
            input,
            resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(overlayId),
            data: nextData,
            dequeueAudit: {
                attempts: carriesPreviousLifecycle ? input.previousEntry.dequeueAudit.attempts : 0
            },
            entryAudit: input.previousEntry.audit,
            messageIdentity: readPreviousMessageIdentity(input.previousEntry)
        }),
        successorEntry
    };
}

/**
 * A stored coalesced row never rewrites its created-audit columns — both the
 * pending merge and the terminal revival compare-and-set update the resource
 * and lifecycle only. Every later generation must therefore keep the original
 * message creation and expiry identity, or the row stops satisfying the
 * canonical work contract that release idempotency checks. The latest request
 * and due times live in the coalesced metadata, not the message identity.
 */
function readPreviousMessageIdentity(previousEntry: ResourceEntry): CoalescedMessageIdentity {
    const message = decodePersistedALMessage(previousEntry.resource);
    return {
        tsEpochMs: message.id.ts,
        expiresAtEpochMs: message.constraints?.expiresAtMs ?? null
    };
}

export interface PendingTopologyReplanReader {
    findByKey(key: Key): Promise<ResourceEntry | null>;
}

/** The stored coalesced head row's exact durable key, shared by writer and reader. */
export function toCoalescedGroupRevisionKey(groupRef: GroupRef): Key {
    return toAppQueueKey({
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(toScopedOverlayId(groupRef)),
        contextId: groupStateGroupStorageKey(groupRef)
    });
}

/**
 * The transient half of product decision 11: is a replan queued for this
 * group, and when is it due? Read straight off the coalesced group-revision
 * head row (I14 — its `dueAtEpochMs` doubles as the read surface's "when
 * will this settle"). Queued means the queue will still attempt it: a
 * waiting row (NEW/RETRY) and an executing row (RESERVED) both report
 * queued; a terminal row is settled work. A present row whose envelope no
 * longer decodes still reports queued, with a null due time, rather than
 * hiding work the queue will attempt. Known residue, recorded in the plan:
 * a delta parked on a causal-suffixed successor row behind a reserved head
 * is invisible to this point read for at most its debounce window — the
 * head is RESERVED (reported queued) while the successor is minted, so the
 * blind window opens only between the head completing and the successor
 * dequeuing.
 */
export async function readPendingTopologyReplan(
    reader: PendingTopologyReplanReader,
    groupRef: GroupRef
): Promise<PendingTopologyReplan | null> {
    const entry = await reader.findByKey(toCoalescedGroupRevisionKey(groupRef));
    if (entry === null || !isPendingCoalescedStatus(entry.status)) {
        return null;
    }
    const envelope = tryReadCoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>(entry);
    return {
        reconfigureQueued: true,
        dueAtEpochMs: envelope?.data[COALESCED_APP_OUTBOX_WORK_FIELD].dueAtEpochMs ?? null
    };
}

function isPendingCoalescedStatus(status: EntityStatus): boolean {
    return isMutableCoalescedStatus(status) || status === EntityStatus.RESERVED;
}

/**
 * The M3 change gate applies only to coalesced group-revision recomputes whose
 * request carries a preserve-only topology-config patch; explicit reconfigures
 * and per-command work always rebuilds.
 */
/**
 * Exhaustive origin classification for every persisted work kind: RTT
 * refreshes and the change-gated coalesced deltas (the presence-summary
 * channel, which also carries the lifecycle transitions' follow-ups) are
 * the machinery's own work; a per-command group-revision enqueue — the
 * reconfigure family and config receipts — carries application or operator
 * intent. A new work kind fails the anchor below instead of silently
 * classifying as `commanded` past the freeze.
 */
export function toTopologyWorkOrigin(work: PersistedRtcTopologyWork): TopologyWorkOrigin {
    if (work.kind === 'rtt-refresh') {
        return 'automatic';
    }
    work.kind satisfies 'group-revision';
    return work.origin;
}

export function isChangeGatedGroupRevisionWork(work: PersistedRtcTopologyWork): boolean {
    return (
        work.kind === 'group-revision' &&
        work.origin === 'automatic' &&
        work[COALESCED_APP_OUTBOX_WORK_FIELD] !== undefined &&
        isPreserveOnlyCanonicalGroupTopologyConfigPatch(work.requestOptions)
    );
}

export function mergeRtcTopologyGroupRevisionWork(
    existing: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>,
    timing: TopologyReplanTiming
): CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
    const previous = existing[COALESCED_APP_OUTBOX_WORK_FIELD];
    const next = incoming[COALESCED_APP_OUTBOX_WORK_FIELD];
    const order = compareGroupCausalRevision(
        incoming.sourceGroupStateCausalRevision,
        existing.sourceGroupStateCausalRevision
    );
    if (order === 'incomparable') {
        throw new TypeError('RTC topology group work carries incomparable causal revisions');
    }
    const selected = order === 'dominated' ? existing : incoming;
    return {
        ...incoming,
        groupSnapshot: selected.groupSnapshot,
        sourceGroupStateCausalRevision: selected.sourceGroupStateCausalRevision,
        requestedAtEpochMs: Math.max(existing.requestedAtEpochMs, incoming.requestedAtEpochMs),
        origin: existing.origin === 'commanded' || incoming.origin === 'commanded'
            ? 'commanded'
            : 'automatic',
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...next,
            windowOpenedAtEpochMs: previous.windowOpenedAtEpochMs,
            dueAtEpochMs: computeTopologyReplanDueAt({
                requestedAtEpochMs: next.requestedAtEpochMs,
                windowOpenedAtEpochMs: previous.windowOpenedAtEpochMs,
                previousDueAtEpochMs: previous.dueAtEpochMs,
                timing
            }),
            reasons: [...new Set([...previous.reasons, ...next.reasons])]
        }
    };
}

function toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
    overlayId: string,
    causalRevision: GroupStateCausalRevision
): string {
    return `${overlayId}:group-revision:group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`;
}

function readPreviousCoalescedGroupRevisionEnvelope(
    previousEntry: ResourceEntry
): CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> {
    const envelope = tryReadCoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>(previousEntry);
    if (!envelope || envelope.data.kind !== 'group-revision') {
        throw new TypeError(
            'Coalesced group-revision predecessor is not coalesced topology work: ' +
                previousEntry.key.resourceId
        );
    }
    const metadata = envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
    // The same compatibility read as the work codec: a row written before the
    // series anchor existed opened its series at its own request.
    return metadata.windowOpenedAtEpochMs === undefined
        ? {
            ...envelope,
            data: {
                ...envelope.data,
                [COALESCED_APP_OUTBOX_WORK_FIELD]: { ...metadata, windowOpenedAtEpochMs: metadata.requestedAtEpochMs }
            }
        }
        : envelope;
}

interface CoalescedMessageIdentity {
    readonly tsEpochMs: number;
    readonly expiresAtEpochMs: number | null;
}

interface ToCoalescedGroupRevisionEntryInput {
    readonly input: RtcTopologyCoalescedGroupRevisionInput;
    readonly resourceId: string;
    readonly data: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>;
    readonly dequeueAudit: Readonly<{ attempts: number; }>;
    readonly entryAudit: ResourceEntry['audit'] | null;
    readonly messageIdentity: CoalescedMessageIdentity | null;
}

function toCoalescedGroupRevisionEntry(
    entryInput: ToCoalescedGroupRevisionEntryInput
): ResourceEntry {
    const { input, resourceId, data } = entryInput;
    const createdBy = toAppQueueCreatedBy(input.senderId);
    const contextId = groupStateGroupStorageKey(input.aggregateRef);
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId,
        contextId
    });
    const metadata = data[COALESCED_APP_OUTBOX_WORK_FIELD];
    const messageId = `${resourceId}:g${metadata.generation}`;
    const messageTsEpochMs = entryInput.messageIdentity?.tsEpochMs ?? input.requestedAtEpochMs;
    const messageExpiresAtEpochMs = entryInput.messageIdentity
        ? entryInput.messageIdentity.expiresAtEpochMs
        : input.expireAtEpochMs;
    const envelope: CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> = {
        type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId,
        contextId,
        senderId: createdBy,
        data
    };
    const causalRevision = readGroupCausalRevision(data.groupSnapshot);
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: messageId,
            ts: messageTsEpochMs,
            senderId: createdBy
        },
        route: key,
        ...(messageExpiresAtEpochMs === null
            ? {}
            : { constraints: { expiresAtMs: messageExpiresAtEpochMs } }),
        ordering: {
            orderingKey: key.contextId,
            epoch: causalRevision.groupRevision,
            seq: causalRevision.presenceRevision
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            contentType: 'application/json',
            resource: JSON.stringify(envelope)
        },
        audit: {
            createdBy,
            createdTs: messageTsEpochMs
        }
    };
    const isDue = metadata.dueAtEpochMs <= input.requestedAtEpochMs;
    const createdTs = Temporal.Instant.fromEpochMilliseconds(messageTsEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: isDue ? EntityStatus.NEW : EntityStatus.RETRY,
        audit: entryInput.entryAudit ?? {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: entryInput.dequeueAudit.attempts,
            nextTs: isDue ? undefined : Temporal.Instant.fromEpochMilliseconds(metadata.dueAtEpochMs)
        }
    };
}

function assertCoalescedGroupRevisionInput(input: RtcTopologyCoalescedGroupRevisionInput): void {
    const snapshot = input.groupSnapshot;
    validateAuthoritativeGroupSnapshot(snapshot);
    if (
        input.senderId.length === 0 ||
        !Number.isSafeInteger(input.requestedAtEpochMs) ||
        !Number.isSafeInteger(input.expireAtEpochMs) ||
        input.requestedAtEpochMs < 0 ||
        !isValidTopologyReplanTiming(input.timing) ||
        input.expireAtEpochMs <= input.requestedAtEpochMs ||
        input.aggregateRef.applicationId !== snapshot.group.applicationId ||
        input.aggregateRef.workspaceId !== snapshot.group.workspaceId ||
        input.aggregateRef.groupId !== snapshot.group.groupId
    ) {
        throw new TypeError('Coalesced RTC topology group-revision facts are invalid');
    }
}

function isValidTopologyReplanTiming(timing: TopologyReplanTiming): boolean {
    const { window } = timing;
    return Number.isSafeInteger(window.debounceMs) && window.debounceMs >= 0 &&
        (window.maxWaitMs === null || (Number.isSafeInteger(window.maxWaitMs) && window.maxWaitMs >= 0)) &&
        Number.isSafeInteger(timing.minimumLayoutAgeMs) && timing.minimumLayoutAgeMs >= 0 &&
        (timing.plannedLayoutUpdatedAtEpochMs === null || Number.isSafeInteger(timing.plannedLayoutUpdatedAtEpochMs));
}
