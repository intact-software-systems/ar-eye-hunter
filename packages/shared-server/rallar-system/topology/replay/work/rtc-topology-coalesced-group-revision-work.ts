import { Temporal } from '@js-temporal/polyfill';

import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { PendingTopologyReplan } from '@shared/api/graph-topology-management-types.ts';
import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import {
    isPreserveOnlyCanonicalGroupTopologyConfigPatch,
    toCanonicalGroupTopologyConfigPatch
} from '@shared/api/group-topology-config-canonical.ts';
import {
    toCanonicalGroupRef,
    type GroupRef,
    type GroupSnapshot,
    type GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import {
    EntityStatus,
    isFailed,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { readRtcTopologyWorkEntry } from '@shared/queuebox/rtc-topology-work-entry-contract.ts';

import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { AppOutboxType } from '../../../app-outbox/app-outbox-type.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    computeCoalescedAppOutboxWork,
    isMutableCoalescedStatus,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkMetadata,
    type ComputedCoalescedAppOutboxWork
} from '../../../app-outbox/coalesced-app-outbox-work.ts';
import { groupStateGroupStorageKey } from '../../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '../../mutation/rtc-topology-outbox-entry.ts';
import type { RtcTopologyGroupRevisionWork } from '../../mutation/rtc-topology-outbox-entry.ts';
import type { TopologyWorkOrigin } from '../../planning/resolve-topology-plan-action.ts';
import type { TopologyReplanWindow } from '../../planning/resolve-topology-replan-window.ts';
import { readRtcTopologyWorkEnvelope, type PersistedRtcTopologyWork } from './rtc-topology-work-codec.ts';

/** The timing facts a replan's due time is computed from (product decision 31, I28 and I29). */
export interface TopologyReplanTiming {
    readonly window: TopologyReplanWindow;
    /**
     * The earliest a replan of the current planned layout may be due (its
     * last write plus the minimum layout age); null when no live planned
     * layout is ageing.
     */
    readonly replanNotBeforeEpochMs: number | null;
    /** This change brings the present members to the group's expected member count, so no arrival is left to coalesce (D288). */
    readonly expectedMembersArrived: boolean;
}

/** The coalescing reason a series carries once its expected members have arrived; its due time no longer extends (D288). */
export const TOPOLOGY_EXPECTED_MEMBERS_ARRIVED_REASON = 'expected-members-arrived';

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
    /** The queued row this change extends; null for the first change of a series. */
    readonly previous:
        | Pick<CoalescedAppOutboxWorkMetadata, 'windowOpenedAtEpochMs' | 'dueAtEpochMs' | 'reasons'>
        | null;
    readonly timing: TopologyReplanTiming;
}

/**
 * The extending window keeps its coalescing benefit but cannot defer a replan
 * past the series' maximum wait (product decision 31). The change that brings
 * the expected members in is due at once, and later changes of that series no
 * longer extend it (D288). The layout-age floor is applied last because it is
 * short.
 */
export function computeTopologyReplanDueAt(input: ComputeTopologyReplanDueAtInput): number {
    return Math.max(computeTopologyReplanWindowDueAt(input), input.timing.replanNotBeforeEpochMs ?? 0);
}

function computeTopologyReplanWindowDueAt(input: ComputeTopologyReplanDueAtInput): number {
    const { timing, previous } = input;
    if (timing.expectedMembersArrived) {
        return Math.min(input.requestedAtEpochMs, previous?.dueAtEpochMs ?? input.requestedAtEpochMs);
    }
    if (previous?.reasons.includes(TOPOLOGY_EXPECTED_MEMBERS_ARRIVED_REASON)) {
        return previous.dueAtEpochMs;
    }
    const windowOpenedAtEpochMs = previous?.windowOpenedAtEpochMs ?? input.requestedAtEpochMs;
    const extended = Math.max(
        previous?.dueAtEpochMs ?? 0,
        input.requestedAtEpochMs + timing.window.debounceMs
    );
    return Math.min(extended, windowOpenedAtEpochMs + timing.window.maxWaitMs);
}

export function toRtcTopologyCoalescedGroupRevisionResourceId(overlayId: string): string {
    return `${overlayId}:group-revision`;
}

export function computeCoalescedRtcTopologyGroupRevisionWork(
    input: RtcTopologyCoalescedGroupRevisionInput
): ComputedCoalescedAppOutboxWork {
    assertCoalescedGroupRevisionInput(input);
    const overlayId = toScopedOverlayId(input.aggregateRef);
    const incoming = toFreshCoalescedGroupRevisionData(input, overlayId);
    const successorEntry = toCoalescedGroupRevisionEntry({
        input,
        resourceId: toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
            overlayId,
            incoming.sourceGroupStateCausalRevision
        ),
        data: incoming,
        dequeueAudit: { attempts: 0, nextTs: undefined },
        entryAudit: null,
        messageIdentity: null
    });
    if (input.previousEntry === null) {
        return computeCoalescedAppOutboxWork(
            null,
            toCoalescedGroupRevisionEntry({
                input,
                resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(overlayId),
                data: incoming,
                dequeueAudit: { attempts: 0, nextTs: undefined },
                entryAudit: null,
                messageIdentity: null
            }),
            successorEntry
        );
    }
    return computeCoalescedAppOutboxWork(
        input.previousEntry,
        toMergedCoalescedGroupRevisionEntry(input, input.previousEntry, incoming),
        successorEntry
    );
}

function toFreshCoalescedGroupRevisionData(
    input: RtcTopologyCoalescedGroupRevisionInput,
    overlayId: string
): CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> {
    return {
        kind: 'group-revision',
        overlayId,
        groupRef: toCanonicalGroupRef(input.aggregateRef),
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
                previous: null,
                timing: input.timing
            }),
            reasons: input.timing.expectedMembersArrived
                ? ['group-revision', TOPOLOGY_EXPECTED_MEMBERS_ARRIVED_REASON]
                : ['group-revision']
        }
    };
}

function toMergedCoalescedGroupRevisionEntry(
    input: RtcTopologyCoalescedGroupRevisionInput,
    previousEntry: ResourceEntry,
    incoming: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>
): ResourceEntry {
    const previous = readPreviousCoalescedGroupRevisionWork(previousEntry);
    if (previous.envelope.data.overlayId !== incoming.overlayId) {
        throw new TypeError('Coalesced group-revision predecessor belongs to another room');
    }
    const carriesPreviousLifecycle = isMutableCoalescedStatus(previousEntry.status);
    const merged = carriesPreviousLifecycle
        ? mergeRtcTopologyGroupRevisionWork(previous.envelope.data, incoming, input.timing)
        : incoming;
    const nextData: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork> = {
        ...merged,
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            ...merged[COALESCED_APP_OUTBOX_WORK_FIELD],
            generation: previous.envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD].generation + 1,
            requestedAtEpochMs: input.requestedAtEpochMs
        }
    };
    return toCoalescedGroupRevisionEntry({
        input,
        resourceId: toRtcTopologyCoalescedGroupRevisionResourceId(incoming.overlayId),
        data: nextData,
        dequeueAudit: carriesPreviousLifecycle
            ? { attempts: previousEntry.dequeueAudit.attempts, nextTs: previousEntry.dequeueAudit.nextTs }
            : { attempts: 0, nextTs: undefined },
        entryAudit: previousEntry.audit,
        messageIdentity: previous.messageIdentity
    });
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
 * longer decodes still reports queued, with a null due time and generation,
 * rather than hiding work the queue will attempt. Known residue, recorded in
 * the plan: a delta parked on a causal-suffixed successor row behind a
 * reserved head is invisible to this point read for at most its debounce
 * window — the head is RESERVED (reported queued) while the successor is
 * minted, so the blind window opens only between the head completing and
 * the successor dequeuing.
 */
export async function readPendingTopologyReplan(
    reader: PendingTopologyReplanReader,
    groupRef: GroupRef
): Promise<PendingTopologyReplan | null> {
    const entry = await reader.findByKey(toCoalescedGroupRevisionKey(groupRef));
    if (entry === null || !isPendingCoalescedStatus(entry.status)) {
        return null;
    }
    const metadata = readPendingCoalescedMetadata(entry);
    return {
        reconfigureQueued: true,
        dueAtEpochMs: metadata?.dueAtEpochMs ?? null,
        generation: metadata?.generation ?? null
    };
}

function isPendingCoalescedStatus(status: EntityStatus): boolean {
    return isMutableCoalescedStatus(status) || status === EntityStatus.RESERVED;
}

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

/**
 * The M3 change gate applies only to coalesced group-revision recomputes whose
 * request carries a preserve-only topology-config patch; explicit reconfigures
 * and per-command work always rebuild.
 */
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
                previous,
                timing
            }),
            reasons: [...new Set([...previous.reasons, ...next.reasons])]
        }
    };
}

/** The replan a successor key asks for: its room, its source causal revision and the request's origin. */
export interface RtcTopologySuccessorRequest {
    readonly overlayId: string;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly origin: TopologyWorkOrigin;
}

/**
 * How a successor already stored under this request's successor key stands to the request. The key names the room and
 * the source causal revision, so a stored row of the same room and revision already asks for that revision's replan:
 * an automatic request adds nothing to it, and its earlier due time stands. A commanded request must rebuild, which a
 * stored automatic row may not, and no request may rest on a row that failed for good; both wait for the head to
 * settle, whose revival then carries them. A stored row of another room or revision under the same key is not that
 * request.
 */
export type QueuedRtcTopologySuccessor = 'serves-request' | 'request-waits-for-head' | 'different-request';

export function resolveQueuedRtcTopologySuccessor(
    request: RtcTopologySuccessorRequest,
    observed: ResourceEntry
): QueuedRtcTopologySuccessor {
    let queued: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>;
    try {
        queued = readPreviousCoalescedGroupRevisionWork(observed).envelope.data;
    }
    catch {
        return 'different-request';
    }
    if (
        queued.overlayId !== request.overlayId ||
        compareGroupCausalRevision(queued.sourceGroupStateCausalRevision, request.sourceGroupStateCausalRevision) !==
            'equal'
    ) {
        return 'different-request';
    }
    if (isFailed(observed.status)) {
        return 'request-waits-for-head';
    }
    return request.origin === 'automatic' || queued.origin === 'commanded'
        ? 'serves-request'
        : 'request-waits-for-head';
}

function toRtcTopologyCoalescedGroupRevisionSuccessorResourceId(
    overlayId: string,
    causalRevision: GroupStateCausalRevision
): string {
    return `${overlayId}:group-revision:group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`;
}

interface PreviousCoalescedGroupRevisionWork {
    readonly envelope: CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork>;
    readonly messageIdentity: CoalescedMessageIdentity;
}

/**
 * A stored coalesced row never rewrites its created-audit columns — both the
 * pending merge and the terminal revival compare-and-set update the resource
 * and lifecycle only. Every later generation must therefore keep the original
 * message sender, creation and expiry identity, or the row stops satisfying the
 * canonical work contract that release idempotency checks. The latest request
 * and due times live in the coalesced metadata, not the message identity.
 */
function readPreviousCoalescedGroupRevisionWork(previousEntry: ResourceEntry): PreviousCoalescedGroupRevisionWork {
    try {
        const message = readRtcTopologyWorkEntry(previousEntry);
        const envelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
        const work = envelope.data;
        if (work.kind !== 'group-revision' || !work[COALESCED_APP_OUTBOX_WORK_FIELD]) {
            throw new TypeError('Coalesced group-revision predecessor lacks group-revision metadata');
        }
        return {
            envelope: {
                ...envelope,
                data: { ...work, [COALESCED_APP_OUTBOX_WORK_FIELD]: work[COALESCED_APP_OUTBOX_WORK_FIELD] }
            },
            messageIdentity: {
                senderId: message.id.senderId,
                tsEpochMs: message.id.ts,
                expiresAtEpochMs: message.constraints?.expiresAtMs ?? null
            }
        };
    }
    catch (cause) {
        throw new TypeError(
            'Coalesced group-revision predecessor is not coalesced topology work: ' + previousEntry.key.resourceId,
            { cause }
        );
    }
}

function readPendingCoalescedMetadata(entry: ResourceEntry): CoalescedAppOutboxWorkMetadata | null {
    try {
        return readPreviousCoalescedGroupRevisionWork(entry).envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
    }
    catch {
        return null;
    }
}

interface CoalescedMessageIdentity {
    readonly senderId: string;
    readonly tsEpochMs: number;
    readonly expiresAtEpochMs: number | null;
}

interface ToCoalescedGroupRevisionEntryInput {
    readonly input: RtcTopologyCoalescedGroupRevisionInput;
    readonly resourceId: string;
    readonly data: CoalescedAppOutboxWorkData<RtcTopologyGroupRevisionWork>;
    /** The attempts and retry time the row carries forward; a fresh row has neither. */
    readonly dequeueAudit: Pick<ResourceEntry['dequeueAudit'], 'attempts' | 'nextTs'>;
    readonly entryAudit: ResourceEntry['audit'] | null;
    readonly messageIdentity: CoalescedMessageIdentity | null;
}

function toCoalescedGroupRevisionEntry(
    entryInput: ToCoalescedGroupRevisionEntryInput
): ResourceEntry {
    const { input, resourceId, data } = entryInput;
    const createdBy = entryInput.messageIdentity?.senderId ?? toAppQueueCreatedBy(input.senderId);
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId,
        contextId: groupStateGroupStorageKey(input.aggregateRef)
    });
    const messageTsEpochMs = entryInput.messageIdentity?.tsEpochMs ?? input.requestedAtEpochMs;
    const message = toCoalescedGroupRevisionMessage(entryInput, key, messageTsEpochMs);
    const metadata = data[COALESCED_APP_OUTBOX_WORK_FIELD];
    // NEW is the shape of a row no attempt has touched; a head that already
    // failed an attempt keeps RETRY, due at the later of the window's due
    // time and its retry backoff, even when the bounded window makes a merge
    // due at once.
    const isDue = metadata.dueAtEpochMs <= input.requestedAtEpochMs;
    const status = isDue && entryInput.dequeueAudit.attempts === 0 ? EntityStatus.NEW : EntityStatus.RETRY;
    const createdTs = Temporal.Instant.fromEpochMilliseconds(messageTsEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status,
        audit: entryInput.entryAudit ?? {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: entryInput.dequeueAudit.attempts,
            nextTs: status === EntityStatus.NEW
                ? undefined
                : Temporal.Instant.fromEpochMilliseconds(
                    computeCoalescedRetryAtEpochMs(metadata, entryInput.dequeueAudit)
                )
        }
    };
}

/**
 * A head that already failed an attempt keeps its retry backoff: the window may make the merged
 * change due sooner, but never earlier than the failed recompute's next retry (D274).
 */
function computeCoalescedRetryAtEpochMs(
    metadata: CoalescedAppOutboxWorkMetadata,
    dequeueAudit: ToCoalescedGroupRevisionEntryInput['dequeueAudit']
): number {
    const backoffUntilEpochMs = dequeueAudit.attempts > 0 ? dequeueAudit.nextTs?.epochMilliseconds ?? 0 : 0;
    return Math.max(metadata.dueAtEpochMs, backoffUntilEpochMs);
}

function toCoalescedGroupRevisionMessage(
    entryInput: ToCoalescedGroupRevisionEntryInput,
    key: Key,
    messageTsEpochMs: number
): ALMessage {
    const { input, resourceId, data } = entryInput;
    const createdBy = entryInput.messageIdentity?.senderId ?? toAppQueueCreatedBy(input.senderId);
    const messageExpiresAtEpochMs = entryInput.messageIdentity
        ? entryInput.messageIdentity.expiresAtEpochMs
        : input.expireAtEpochMs;
    const envelope: CoalescedAppOutboxWorkEnvelope<RtcTopologyGroupRevisionWork> = {
        type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId,
        contextId: groupStateGroupStorageKey(input.aggregateRef),
        senderId: createdBy,
        data
    };
    const causalRevision = data.sourceGroupStateCausalRevision;
    return {
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: `${resourceId}:g${data[COALESCED_APP_OUTBOX_WORK_FIELD].generation}`,
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
}

function assertCoalescedGroupRevisionInput(input: RtcTopologyCoalescedGroupRevisionInput): void {
    const snapshot = input.groupSnapshot;
    validateAuthoritativeGroupSnapshot(snapshot);
    if (
        input.senderId.length === 0 ||
        !isNonNegativeSafeInteger(input.requestedAtEpochMs) ||
        !Number.isSafeInteger(input.expireAtEpochMs) ||
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
    return isNonNegativeSafeInteger(window.debounceMs) &&
        isNonNegativeSafeInteger(window.maxWaitMs) &&
        typeof timing.expectedMembersArrived === 'boolean' &&
        (timing.replanNotBeforeEpochMs === null || isNonNegativeSafeInteger(timing.replanNotBeforeEpochMs));
}

function isNonNegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}
