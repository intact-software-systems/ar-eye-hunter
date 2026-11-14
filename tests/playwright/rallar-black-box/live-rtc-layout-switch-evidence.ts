import {
    isGroupLayoutIdentity,
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import type { AgentPrefix } from './live-rtc-delivery-operations.ts';
import {
    jsonRecord,
    numberValue,
    stringArrayValue,
    stringValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';

export const LIVE_RTC_LAYOUT_SWITCH_FRAME_TOPIC = 'rallar.black-box.layout-switch-stream';

const FORMATION_CHANGED_TOPIC = 'rallar.browser.formation.changed';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const RTC_SEND_COMPLETED_TOPIC = 'rallar.browser.messages.rtc.send_completed';
const STREAM_STARTED_TOPIC = 'rallar.bb.rtc.stream_started';
const PLANNED_LAYOUT_NOT_YET_IN_SYNC = `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`;

/** One browser's stream as its own `rtc.stream` result reported it. */
export interface LiveRtcLayoutSwitchStream {
    readonly prefix: AgentPrefix;
    readonly agentId: string;
    readonly sessionId: string;
    readonly result: LiveRtcJsonRecord;
}

/** A switch is the identity every browser promoted to and the moment the owner issued it, on the test's clock. */
export interface LiveRtcLayoutSwitch {
    readonly identity: GroupLayoutIdentity;
    readonly requestedAtEpochMs: number;
}

export interface LiveRtcLayoutSwitchEvidenceInput {
    readonly runId: string;
    readonly streams: readonly LiveRtcLayoutSwitchStream[];
    readonly switches: readonly [LiveRtcLayoutSwitch, LiveRtcLayoutSwitch];
    readonly leafSessionIds: readonly [string, string];
    readonly events: readonly LiveRtcControlClient.Event[];
}

export interface LiveRtcStreamDelivery {
    readonly origin: AgentPrefix;
    readonly receiver: AgentPrefix;
    readonly plannedFrames: number;
    readonly missingSeqs: readonly number[];
    readonly duplicatedSeqs: readonly number[];
}

export interface LiveRtcUnsentFrame {
    readonly origin: AgentPrefix;
    readonly seq: number;
    readonly status: string | null;
    readonly errorCode: string | null;
}

export interface LiveRtcRefusalRecord {
    readonly agent: AgentPrefix;
    readonly atEpochMs: number;
    readonly detail: LiveRtcJsonRecord;
}

export interface LiveRtcStreamPromotion {
    readonly prefix: AgentPrefix;
    readonly firstFrameAtEpochMs: number | null;
    readonly lastFrameAtEpochMs: number | null;
    readonly promotedAtEpochMs: readonly [number | null, number | null];
}

/** The frames a leaf sent while it held the tree, and those of them its fellow leaf never received. */
export interface LiveRtcLeafCrossing {
    readonly origin: AgentPrefix;
    readonly otherLeaf: AgentPrefix;
    readonly framesSentOnTree: number;
    readonly missingAtOtherLeaf: readonly number[];
}

export interface LiveRtcLayoutSwitchObservations {
    readonly promotionLatencyMs: Readonly<Record<AgentPrefix, readonly [number | null, number | null]>>;
    readonly notYetInSyncAdmissions: Readonly<Record<AgentPrefix, { total: number; plannedLayout: number; }>>;
    readonly wireDuplicates: Readonly<Record<AgentPrefix, number>>;
    readonly unconfirmedHops: Readonly<Record<AgentPrefix, { frames: number; peerIds: readonly string[]; }>>;
    readonly receiptExhausted: readonly { agent: AgentPrefix; topic: string; kind: string | null; }[];
}

export interface LiveRtcLayoutSwitchEvidence {
    /** The stream-start diagnostic of every browser was retained: the control server kept the whole run. */
    readonly runRetained: boolean;
    readonly inboundAdmissionCount: Readonly<Record<AgentPrefix, number>>;
    readonly deliveries: readonly LiveRtcStreamDelivery[];
    readonly unsentFrames: readonly LiveRtcUnsentFrame[];
    readonly unauthorizedAdmissions: readonly LiveRtcRefusalRecord[];
    readonly senderPlannerDrops: readonly LiveRtcRefusalRecord[];
    readonly promotions: readonly LiveRtcStreamPromotion[];
    readonly leafCrossings: readonly LiveRtcLeafCrossing[];
    readonly observations: LiveRtcLayoutSwitchObservations;
}

interface LiveRtcRunEvent {
    readonly agentId: string;
    readonly kind: string | undefined;
    readonly topic: string | undefined;
    readonly atEpochMs: number;
    readonly data: LiveRtcJsonRecord;
    readonly raw: RtcBaselineJson | undefined;
}

interface StreamFrame {
    readonly seq: number;
    readonly startedAtEpochMs: number;
    readonly ok: boolean;
    readonly status: string | null;
    readonly errorCode: string | null;
}

/** Receiver agent ID, then origin prefix, then how many times each sequence number reached the application. */
type ReceivedFrames = ReadonlyMap<string, ReadonlyMap<AgentPrefix, ReadonlyMap<number, number>>>;

export function computeLiveRtcLayoutSwitchEvidence(
    input: LiveRtcLayoutSwitchEvidenceInput
): LiveRtcLayoutSwitchEvidence {
    const events = input.events.flatMap(toLiveRtcRunEvent);
    const received = computeReceivedFrames(events, input);
    const framesByPrefix = new Map(input.streams.map((stream) => [stream.prefix, toStreamFrames(stream.result)]));
    const windowStartEpochMs = Math.min(
        ...[...framesByPrefix.values()].flatMap((frames) => frames.map((frame) => frame.startedAtEpochMs))
    );
    const runEvents = events.filter((event) => event.atEpochMs >= windowStartEpochMs);
    const promotions = input.streams.map((stream) =>
        toStreamPromotion(stream, framesByPrefix.get(stream.prefix) ?? [], events, input.switches)
    );
    return {
        runRetained: input.streams.every((stream) =>
            events.some((event) => event.agentId === stream.agentId && event.topic === STREAM_STARTED_TOPIC)
        ),
        inboundAdmissionCount: countByPrefix(input.streams, runEvents, (event) => isAdmissionOutcome(event)),
        deliveries: computeDeliveries(input.streams, received),
        unsentFrames: input.streams.flatMap((stream) =>
            (framesByPrefix.get(stream.prefix) ?? []).filter((frame) => !frame.ok).map((frame) => ({
                origin: stream.prefix,
                seq: frame.seq,
                status: frame.status,
                errorCode: frame.errorCode
            }))
        ),
        unauthorizedAdmissions: toRefusalRecords(input.streams, runEvents, isUnauthorizedAdmission),
        senderPlannerDrops: toRefusalRecords(input.streams, runEvents, isSenderPlannerDrop),
        promotions,
        leafCrossings: computeLeafCrossings(input, framesByPrefix, promotions, received),
        observations: computeObservations(input, runEvents, promotions)
    };
}

/** The receivers' application deliveries alone, for the drain poll that waits for late frames. */
export function countLiveRtcMissingFrames(
    input: Pick<LiveRtcLayoutSwitchEvidenceInput, 'runId' | 'streams' | 'events'>
): number {
    const received = computeReceivedFrames(input.events.flatMap(toLiveRtcRunEvent), input);
    return computeDeliveries(input.streams, received).reduce((sum, delivery) => sum + delivery.missingSeqs.length, 0);
}

function toLiveRtcRunEvent(event: LiveRtcControlClient.Event): readonly LiveRtcRunEvent[] {
    const runtime = jsonRecord(event.payload);
    const atEpochMs = numberValue(runtime?.atEpochMs);
    if (runtime === null || event.agentId === undefined || atEpochMs === undefined) {
        return [];
    }
    return [{
        agentId: event.agentId,
        kind: stringValue(runtime.kind),
        topic: stringValue(runtime.topic),
        atEpochMs,
        data: jsonRecord(jsonRecord(runtime.payload)?.data) ?? {},
        raw: event.payload
    }];
}

function computeReceivedFrames(
    events: readonly LiveRtcRunEvent[],
    input: Pick<LiveRtcLayoutSwitchEvidenceInput, 'runId' | 'streams'>
): ReceivedFrames {
    const received = new Map<string, Map<AgentPrefix, Map<number, number>>>();
    const origins = new Set(input.streams.map((stream) => stream.prefix));
    for (const event of events) {
        const frame = event.kind === 'message' ? jsonRecord(event.data.payload) : null;
        const origin = stringValue(frame?.origin);
        const seq = numberValue(frame?.seq);
        if (
            frame?.topic !== LIVE_RTC_LAYOUT_SWITCH_FRAME_TOPIC || frame.runId !== input.runId || seq === undefined ||
            !isStreamOrigin(origin, origins)
        ) {
            continue;
        }
        const byOrigin = received.get(event.agentId) ?? new Map<AgentPrefix, Map<number, number>>();
        const counts = byOrigin.get(origin) ?? new Map<number, number>();
        counts.set(seq, (counts.get(seq) ?? 0) + 1);
        byOrigin.set(origin, counts);
        received.set(event.agentId, byOrigin);
    }
    return received;
}

function isStreamOrigin(value: string | undefined, origins: ReadonlySet<AgentPrefix>): value is AgentPrefix {
    return [...origins].some((origin) => origin === value);
}

function computeDeliveries(
    streams: readonly LiveRtcLayoutSwitchStream[],
    received: ReceivedFrames
): readonly LiveRtcStreamDelivery[] {
    return streams.flatMap((origin) => {
        const plannedFrames = numberValue(origin.result.plannedFrames) ?? 0;
        return streams.filter((receiver) => receiver.agentId !== origin.agentId).map((receiver) => {
            const counts = received.get(receiver.agentId)?.get(origin.prefix) ?? new Map<number, number>();
            const seqs = Array.from({ length: plannedFrames }, (_, index) => index + 1);
            return {
                origin: origin.prefix,
                receiver: receiver.prefix,
                plannedFrames,
                missingSeqs: seqs.filter((seq) => !counts.has(seq)),
                duplicatedSeqs: seqs.filter((seq) => (counts.get(seq) ?? 0) > 1)
            };
        });
    });
}

function toStreamFrames(result: LiveRtcJsonRecord): readonly StreamFrame[] {
    const observations = Array.isArray(result.observations) ? result.observations : [];
    return observations.flatMap((value) => {
        const observation = jsonRecord(value);
        const seq = numberValue(observation?.iteration);
        const startedAtEpochMs = numberValue(observation?.startedAtEpochMs);
        if (observation === null || seq === undefined || startedAtEpochMs === undefined) {
            return [];
        }
        return [{
            seq,
            startedAtEpochMs,
            ok: observation.ok === true && observation.dropped !== true,
            status: stringValue(observation.status) ?? null,
            errorCode: stringValue(observation.errorCode) ?? null
        }];
    });
}

function toStreamPromotion(
    stream: LiveRtcLayoutSwitchStream,
    frames: readonly StreamFrame[],
    events: readonly LiveRtcRunEvent[],
    switches: LiveRtcLayoutSwitchEvidenceInput['switches']
): LiveRtcStreamPromotion {
    const starts = frames.map((frame) => frame.startedAtEpochMs);
    return {
        prefix: stream.prefix,
        firstFrameAtEpochMs: starts.length === 0 ? null : Math.min(...starts),
        lastFrameAtEpochMs: starts.length === 0 ? null : Math.max(...starts),
        promotedAtEpochMs: [
            readPromotedAtEpochMs(stream.agentId, events, switches[0].identity),
            readPromotedAtEpochMs(stream.agentId, events, switches[1].identity)
        ]
    };
}

/** The first formation change in which this browser's accepted layout is the switch's identity. */
function readPromotedAtEpochMs(
    agentId: string,
    events: readonly LiveRtcRunEvent[],
    identity: GroupLayoutIdentity
): number | null {
    const promoted = events.filter((event) => {
        const accepted = jsonRecord(event.data.accepted)?.identity;
        return event.agentId === agentId && event.topic === FORMATION_CHANGED_TOPIC &&
            isGroupLayoutIdentity(accepted) && isSameGroupLayoutIdentity(accepted, identity);
    });
    return promoted.length === 0 ? null : Math.min(...promoted.map((event) => event.atEpochMs));
}

function computeLeafCrossings(
    input: LiveRtcLayoutSwitchEvidenceInput,
    framesByPrefix: ReadonlyMap<AgentPrefix, readonly StreamFrame[]>,
    promotions: readonly LiveRtcStreamPromotion[],
    received: ReceivedFrames
): readonly LiveRtcLeafCrossing[] {
    const leaves = input.leafSessionIds.flatMap((sessionId) =>
        input.streams.filter((stream) => stream.sessionId === sessionId)
    );
    return leaves.flatMap((origin) => {
        const otherLeaf = leaves.find((leaf) => leaf.agentId !== origin.agentId);
        const [onTreeFrom, onTreeUntil] = promotions.find((entry) => entry.prefix === origin.prefix)
            ?.promotedAtEpochMs ?? [null, null];
        if (otherLeaf === undefined || onTreeFrom === null || onTreeUntil === null) {
            return [];
        }
        const sent = (framesByPrefix.get(origin.prefix) ?? []).filter((frame) =>
            frame.startedAtEpochMs >= onTreeFrom && frame.startedAtEpochMs < onTreeUntil
        );
        const counts = received.get(otherLeaf.agentId)?.get(origin.prefix);
        return [{
            origin: origin.prefix,
            otherLeaf: otherLeaf.prefix,
            framesSentOnTree: sent.length,
            missingAtOtherLeaf: sent.map((frame) => frame.seq).filter((seq) => !counts?.has(seq))
        }];
    });
}

function computeObservations(
    input: LiveRtcLayoutSwitchEvidenceInput,
    runEvents: readonly LiveRtcRunEvent[],
    promotions: readonly LiveRtcStreamPromotion[]
): LiveRtcLayoutSwitchObservations {
    return {
        promotionLatencyMs: mapByPrefix(input.streams, (stream) => {
            const promotedAt = promotions.find((promotion) => promotion.prefix === stream.prefix)
                ?.promotedAtEpochMs ?? [null, null];
            return [
                toLatencyMs(promotedAt[0], input.switches[0]),
                toLatencyMs(promotedAt[1], input.switches[1])
            ] as const;
        }),
        notYetInSyncAdmissions: mapByPrefix(input.streams, (stream) => {
            const admissions = runEvents.filter((event) =>
                event.agentId === stream.agentId && isAdmissionOutcome(event) &&
                stringValue(event.data.reason)?.startsWith('not-yet-in-sync') === true
            );
            return {
                total: admissions.length,
                plannedLayout: admissions.filter((event) => event.data.reason === PLANNED_LAYOUT_NOT_YET_IN_SYNC).length
            };
        }),
        wireDuplicates: countByPrefix(
            input.streams,
            runEvents,
            (event) =>
                isAdmissionOutcome(event) && event.data.outcome === 'not-handled' && event.data.reason === 'duplicate'
        ),
        unconfirmedHops: mapByPrefix(input.streams, (stream) => {
            const unconfirmed = runEvents.filter((event) => event.agentId === stream.agentId)
                .flatMap((event) => event.topic === RTC_SEND_COMPLETED_TOPIC ? [jsonRecord(event.data.message)] : [])
                .map((message) => stringArrayValue(message?.unconfirmedHopPeerIds))
                .filter((peerIds) => peerIds.length > 0);
            return { frames: unconfirmed.length, peerIds: [...new Set(unconfirmed.flat())].sort() };
        }),
        receiptExhausted: runEvents.filter((event) => JSON.stringify(event.raw).includes('receipt-exhausted'))
            .flatMap((event) => {
                const agent = input.streams.find((stream) => stream.agentId === event.agentId)?.prefix;
                return agent === undefined
                    ? []
                    : [{ agent, topic: event.topic ?? 'unknown', kind: stringValue(event.data.kind) ?? null }];
            })
    };
}

function toLatencyMs(promotedAtEpochMs: number | null, layoutSwitch: LiveRtcLayoutSwitch): number | null {
    return promotedAtEpochMs === null ? null : promotedAtEpochMs - layoutSwitch.requestedAtEpochMs;
}

function isAdmissionOutcome(event: LiveRtcRunEvent): boolean {
    return event.topic === INBOUND_DIAGNOSTICS_TOPIC && event.data.kind === 'admission-outcome';
}

function isUnauthorizedAdmission(event: LiveRtcRunEvent): boolean {
    return isAdmissionOutcome(event) && event.data.outcome === 'unauthorized';
}

/** A sender's own planner drop settles its frame as a skipped failure that names the drop. */
function isSenderPlannerDrop(event: LiveRtcRunEvent): boolean {
    const failure = jsonRecord(jsonRecord(event.data.message)?.failure);
    return event.topic === RTC_SEND_COMPLETED_TOPIC && failure?.kind === 'skipped' &&
        failure.reason === 'planner-drop';
}

function toRefusalRecords(
    streams: readonly LiveRtcLayoutSwitchStream[],
    events: readonly LiveRtcRunEvent[],
    matches: (event: LiveRtcRunEvent) => boolean
): readonly LiveRtcRefusalRecord[] {
    return events.filter(matches).flatMap((event) => {
        const agent = streams.find((stream) => stream.agentId === event.agentId)?.prefix;
        return agent === undefined ? [] : [{ agent, atEpochMs: event.atEpochMs, detail: event.data }];
    });
}

function countByPrefix(
    streams: readonly LiveRtcLayoutSwitchStream[],
    events: readonly LiveRtcRunEvent[],
    matches: (event: LiveRtcRunEvent) => boolean
): Readonly<Record<AgentPrefix, number>> {
    return mapByPrefix(
        streams,
        (stream) => events.filter((event) => event.agentId === stream.agentId && matches(event)).length
    );
}

function mapByPrefix<T>(
    streams: readonly LiveRtcLayoutSwitchStream[],
    toValue: (stream: LiveRtcLayoutSwitchStream) => T
): Readonly<Record<AgentPrefix, T>> {
    return Object.fromEntries(streams.map((stream) => [stream.prefix, toValue(stream)])) as Record<AgentPrefix, T>;
}
