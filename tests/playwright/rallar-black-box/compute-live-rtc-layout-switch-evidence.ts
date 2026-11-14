import {
    isGroupLayoutIdentity,
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import { computeLiveRtcCarryingEdges, type LiveRtcCarryingEdges } from './compute-live-rtc-carrying-edges.ts';
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
const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';

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
    /** The typed channel's type the frames travel on; its admission outcomes are the completeness guard's count. */
    readonly frameTypeId: string;
    readonly streams: readonly LiveRtcLayoutSwitchStream[];
    readonly switches: readonly [LiveRtcLayoutSwitch, LiveRtcLayoutSwitch];
    readonly leafSessionIds: readonly [string, string];
    readonly relaySessionId: string;
    readonly events: readonly LiveRtcControlClient.Event[];
}

/** One application delivery of a frame: a second copy with the same `msgId` and `transport` is the harness's. */
export interface LiveRtcFrameCopy {
    readonly msgId: string | null;
    readonly transport: string | null;
    /** The message's trace, which the receiver's ACK of this copy names too. */
    readonly traceId: string | null;
}

/**
 * The counts that show two gated zeros are readings: every planned frame has a stream observation (unsent frames),
 * and every frame a `send_completed` event, the stream the sender planner-drop reading is taken from.
 */
export interface LiveRtcSendReadings {
    readonly plannedFrames: number;
    readonly observedFrames: number;
    readonly sendCompletedEvents: number;
}

export interface LiveRtcStreamDelivery {
    readonly origin: AgentPrefix;
    readonly receiver: AgentPrefix;
    readonly plannedFrames: number;
    readonly missingSeqs: readonly number[];
    readonly duplicatedSeqs: readonly { seq: number; copies: readonly LiveRtcFrameCopy[]; }[];
}

/** The sender's delivery lifecycle as `send_completed` stated it for one failed send. */
export interface LiveRtcSendSettlement {
    readonly atEpochMs: number;
    readonly handleId: string | null;
    readonly state: string | null;
    /** For a capacity refusal: `{ kind: 'refused', reason: 'capacity', limit }`. */
    readonly failure: RtcBaselineJson | null;
    /** For a capacity refusal: the budget's text with the usage it passed. */
    readonly reason: string | null;
    readonly attemptOutcomes: readonly string[];
    readonly attemptRefusalReasons: readonly string[];
}

export interface LiveRtcUnsentFrame {
    readonly origin: AgentPrefix;
    readonly seq: number;
    readonly status: string | null;
    readonly errorCode: string | null;
    readonly completedAtEpochMs: number | null;
    /** The failed send on the sender's page nearest this frame's completion; null when none was recorded. */
    readonly send: LiveRtcSendSettlement | null;
}

export interface LiveRtcRefusalRecord {
    readonly agent: AgentPrefix;
    readonly atEpochMs: number;
    readonly detail: LiveRtcJsonRecord;
}

/**
 * A receiver admits every frame it delivers, so its committed admissions of the frame type are at least its distinct
 * received frames; `expectedFrames` is what a lossless run delivers: the two other streams' planned frames.
 */
export interface LiveRtcAdmissionCompleteness {
    readonly committedFrameAdmissions: number;
    readonly receivedFrames: number;
    readonly expectedFrames: number;
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
    readonly carryingEdges: readonly LiveRtcCarryingEdges[];
    readonly receiptExhausted: readonly { agent: AgentPrefix; topic: string; kind: string | null; }[];
}

export interface LiveRtcLayoutSwitchEvidence {
    /** The stream-start diagnostic of every browser was retained: the control server kept the whole run. */
    readonly runRetained: boolean;
    readonly admissionCompleteness: Readonly<Record<AgentPrefix, LiveRtcAdmissionCompleteness>>;
    readonly sendReadings: Readonly<Record<AgentPrefix, LiveRtcSendReadings>>;
    readonly deliveries: readonly LiveRtcStreamDelivery[];
    readonly unsentFrames: readonly LiveRtcUnsentFrame[];
    /** Unsent frames by `state / failure kind / reason / limit`. */
    readonly unsentByReason: Readonly<Record<string, number>>;
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
    readonly completedAtEpochMs: number | null;
    readonly ok: boolean;
    readonly status: string | null;
    readonly errorCode: string | null;
}

interface ObservationSources {
    readonly framesByPrefix: ReadonlyMap<AgentPrefix, readonly StreamFrame[]>;
    readonly received: ReceivedFrames;
}

/** Receiver agent ID, then origin prefix, then every application delivery of each sequence number. */
type ReceivedFrames = ReadonlyMap<string, ReadonlyMap<AgentPrefix, ReadonlyMap<number, readonly LiveRtcFrameCopy[]>>>;

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
    const unsentFrames = computeUnsentFrames(input.streams, framesByPrefix, runEvents);
    return {
        runRetained: input.streams.every((stream) =>
            events.some((event) => event.agentId === stream.agentId && event.topic === STREAM_STARTED_TOPIC)
        ),
        admissionCompleteness: computeAdmissionCompleteness(input, runEvents, received),
        sendReadings: computeSendReadings(input.streams, framesByPrefix, runEvents),
        deliveries: computeDeliveries(input.streams, received),
        unsentFrames,
        unsentByReason: countUnsentByReason(unsentFrames),
        unauthorizedAdmissions: toRefusalRecords(input.streams, runEvents, isUnauthorizedAdmission),
        senderPlannerDrops: toRefusalRecords(input.streams, runEvents, isSenderPlannerDrop),
        promotions,
        leafCrossings: computeLeafCrossings(input, framesByPrefix, promotions, received),
        observations: computeObservations(input, runEvents, promotions, { framesByPrefix, received })
    };
}

/** How many planned frames every receiver still lacks, for the drain that waits for late publications. */
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
    const received = new Map<string, Map<AgentPrefix, Map<number, LiveRtcFrameCopy[]>>>();
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
        const byOrigin = received.get(event.agentId) ?? new Map<AgentPrefix, Map<number, LiveRtcFrameCopy[]>>();
        const copies = byOrigin.get(origin) ?? new Map<number, LiveRtcFrameCopy[]>();
        copies.set(seq, [...(copies.get(seq) ?? []), toFrameCopy(event)]);
        byOrigin.set(origin, copies);
        received.set(event.agentId, byOrigin);
    }
    return received;
}

function toFrameCopy(event: LiveRtcRunEvent): LiveRtcFrameCopy {
    return {
        msgId: stringValue(event.data.msgId) ?? null,
        traceId: stringValue(event.data.traceId) ?? null,
        transport: stringValue(event.data.transport) ?? stringValue(jsonRecord(event.raw)?.transport) ?? null
    };
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
            const copies = received.get(receiver.agentId)?.get(origin.prefix) ??
                new Map<number, readonly LiveRtcFrameCopy[]>();
            const seqs = Array.from({ length: plannedFrames }, (_, index) => index + 1);
            return {
                origin: origin.prefix,
                receiver: receiver.prefix,
                plannedFrames,
                missingSeqs: seqs.filter((seq) => !copies.has(seq)),
                duplicatedSeqs: seqs.flatMap((seq) => {
                    const seen = copies.get(seq) ?? [];
                    return seen.length > 1 ? [{ seq, copies: seen }] : [];
                })
            };
        });
    });
}

function computeAdmissionCompleteness(
    input: LiveRtcLayoutSwitchEvidenceInput,
    runEvents: readonly LiveRtcRunEvent[],
    received: ReceivedFrames
): Readonly<Record<AgentPrefix, LiveRtcAdmissionCompleteness>> {
    return mapByPrefix(input.streams, (stream) => ({
        committedFrameAdmissions: runEvents.filter((event) =>
            event.agentId === stream.agentId && isAdmissionOutcome(event) && event.data.outcome === 'committed' &&
            event.data.typeId === input.frameTypeId
        ).length,
        receivedFrames: [...(received.get(stream.agentId)?.values() ?? [])]
            .reduce((sum, copies) =>
                sum + copies.size, 0),
        expectedFrames: input.streams.filter((origin) => origin.agentId !== stream.agentId)
            .reduce((sum, origin) => sum + (numberValue(origin.result.plannedFrames) ?? 0), 0)
    }));
}

function computeSendReadings(
    streams: readonly LiveRtcLayoutSwitchStream[],
    framesByPrefix: ReadonlyMap<AgentPrefix, readonly StreamFrame[]>,
    runEvents: readonly LiveRtcRunEvent[]
): Readonly<Record<AgentPrefix, LiveRtcSendReadings>> {
    return mapByPrefix(streams, (stream) => ({
        plannedFrames: numberValue(stream.result.plannedFrames) ?? 0,
        observedFrames: framesByPrefix.get(stream.prefix)?.length ?? 0,
        sendCompletedEvents: runEvents.filter((event) =>
            event.agentId === stream.agentId && event.topic === RTC_SEND_COMPLETED_TOPIC
        ).length
    }));
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
            completedAtEpochMs: numberValue(observation.completedAtEpochMs) ?? null,
            ok: observation.ok === true && observation.dropped !== true,
            status: stringValue(observation.status) ?? null,
            errorCode: stringValue(observation.errorCode) ?? null
        }];
    });
}

/**
 * The stream's frame keeps only a status; the sender's `send_completed` keeps the lifecycle but no sequence number.
 * Each unsent frame takes the send in the frame's own state recorded nearest its completion on the same page clock,
 * each send once; the frame's status is the delivery state, so no copy of the stream's failed-state list is needed.
 */
function computeUnsentFrames(
    streams: readonly LiveRtcLayoutSwitchStream[],
    framesByPrefix: ReadonlyMap<AgentPrefix, readonly StreamFrame[]>,
    runEvents: readonly LiveRtcRunEvent[]
): readonly LiveRtcUnsentFrame[] {
    return streams.flatMap((stream) => {
        const unsent = (framesByPrefix.get(stream.prefix) ?? []).filter((frame) => !frame.ok);
        const unsentStates = new Set(unsent.flatMap((frame) => frame.status ?? []));
        const unmatched = runEvents.filter((event) => event.agentId === stream.agentId)
            .flatMap(toSendSettlement)
            .filter((settlement) => unsentStates.has(settlement.state ?? ''));
        return unsent.map((frame) => ({
            origin: stream.prefix,
            seq: frame.seq,
            status: frame.status,
            errorCode: frame.errorCode,
            completedAtEpochMs: frame.completedAtEpochMs,
            send: takeNearestSettlement(unmatched, frame)
        }));
    });
}

function toSendSettlement(event: LiveRtcRunEvent): readonly LiveRtcSendSettlement[] {
    const message = jsonRecord(event.data.message);
    const state = stringValue(message?.state);
    if (event.topic !== RTC_SEND_COMPLETED_TOPIC || message === null) {
        return [];
    }
    return [{
        atEpochMs: event.atEpochMs,
        handleId: stringValue(message.handleId) ?? null,
        state: state ?? null,
        failure: message.failure ?? null,
        reason: stringValue(message.reason) ?? null,
        attemptOutcomes: stringArrayValue(message.attemptOutcomes),
        attemptRefusalReasons: stringArrayValue(message.attemptRefusalReasons)
    }];
}

function takeNearestSettlement(
    unmatched: LiveRtcSendSettlement[],
    frame: Pick<StreamFrame, 'status' | 'completedAtEpochMs'>
): LiveRtcSendSettlement | null {
    const { completedAtEpochMs } = frame;
    if (completedAtEpochMs === null) {
        return null;
    }
    let nearest = -1;
    for (const [index, settlement] of unmatched.entries()) {
        const distance = Math.abs(settlement.atEpochMs - completedAtEpochMs);
        if (
            settlement.state === frame.status &&
            (nearest < 0 || distance < Math.abs((unmatched[nearest]?.atEpochMs ?? Infinity) - completedAtEpochMs))
        ) {
            nearest = index;
        }
    }
    return nearest < 0 ? null : unmatched.splice(nearest, 1)[0] ?? null;
}

function countUnsentByReason(unsentFrames: readonly LiveRtcUnsentFrame[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const frame of unsentFrames) {
        const failure = jsonRecord(frame.send?.failure);
        const key = [
            frame.send?.state ?? frame.status ?? 'unknown',
            stringValue(failure?.kind) ?? '-',
            stringValue(failure?.reason) ?? '-',
            stringValue(failure?.limit) ?? '-'
        ].join(' / ');
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
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
        const copies = received.get(otherLeaf.agentId)?.get(origin.prefix);
        return [{
            origin: origin.prefix,
            otherLeaf: otherLeaf.prefix,
            framesSentOnTree: sent.length,
            missingAtOtherLeaf: sent.map((frame) => frame.seq).filter((seq) => !copies?.has(seq))
        }];
    });
}

function computeObservations(
    input: LiveRtcLayoutSwitchEvidenceInput,
    runEvents: readonly LiveRtcRunEvent[],
    promotions: readonly LiveRtcStreamPromotion[],
    sources: ObservationSources
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
        notYetInSyncAdmissions: mapByPrefix(input.streams, (stream) => countNotYetInSync(stream, runEvents)),
        wireDuplicates: countByPrefix(
            input.streams,
            runEvents,
            (event) =>
                isAdmissionOutcome(event) && event.data.outcome === 'not-handled' && event.data.reason === 'duplicate'
        ),
        carryingEdges: computeLeafCarryingEdges(input, runEvents, promotions, sources),
        receiptExhausted: readReceiptExhausted(input.streams, runEvents)
    };
}

function countNotYetInSync(
    stream: LiveRtcLayoutSwitchStream,
    runEvents: readonly LiveRtcRunEvent[]
): { total: number; plannedLayout: number; } {
    const admissions = runEvents.filter((event) =>
        event.agentId === stream.agentId && isAdmissionOutcome(event) &&
        stringValue(event.data.reason)?.startsWith('not-yet-in-sync') === true
    );
    return {
        total: admissions.length,
        plannedLayout: admissions.filter((event) => event.data.reason === PLANNED_LAYOUT_NOT_YET_IN_SYNC).length
    };
}

/** For each leaf origin and the other leaf: the tree's window and the star's, each from the origin's own promotion. */
function computeLeafCarryingEdges(
    input: LiveRtcLayoutSwitchEvidenceInput,
    runEvents: readonly LiveRtcRunEvent[],
    promotions: readonly LiveRtcStreamPromotion[],
    sources: ObservationSources
): readonly LiveRtcCarryingEdges[] {
    const leaves = input.streams.filter((stream) => input.leafSessionIds.includes(stream.sessionId));
    return leaves.flatMap((origin) => {
        const receiver = leaves.find((leaf) => leaf.agentId !== origin.agentId);
        const promotedAt = promotions.find((promotion) => promotion.prefix === origin.prefix)?.promotedAtEpochMs;
        if (receiver === undefined || promotedAt === undefined || promotedAt[0] === null || promotedAt[1] === null) {
            return [];
        }
        const windows = [
            { layout: 'tree', from: promotedAt[0], until: promotedAt[1] },
            { layout: 'star', from: promotedAt[1], until: Infinity }
        ] as const;
        const traceIdBySeq = readTraceIdBySeq(sources.received, receiver.agentId, origin.prefix);
        const hopsByTraceId = readAckHopsByTraceId(runEvents, receiver.agentId);
        return windows.map((window) =>
            computeLiveRtcCarryingEdges({
                origin,
                receiver: receiver.prefix,
                relaySessionId: input.relaySessionId,
                layout: window.layout,
                promotedAtEpochMs: window.from,
                frames: (sources.framesByPrefix.get(origin.prefix) ?? []).filter((frame) =>
                    frame.startedAtEpochMs >= window.from && frame.startedAtEpochMs < window.until
                ),
                traceIdBySeq,
                hopsByTraceId
            })
        );
    });
}

function readTraceIdBySeq(
    received: ReceivedFrames,
    receiverAgentId: string,
    origin: AgentPrefix
): ReadonlyMap<number, string> {
    const copies = received.get(receiverAgentId)?.get(origin) ?? new Map<number, readonly LiveRtcFrameCopy[]>();
    return new Map([...copies].flatMap(([seq, seen]) => {
        const traceId = seen.flatMap((copy) => copy.traceId ?? [])[0];
        return traceId === undefined ? [] : [[seq, traceId] as const];
    }));
}

/** The hop each ACK this receiver submitted went to, by the trace of the message it acknowledges. */
function readAckHopsByTraceId(
    runEvents: readonly LiveRtcRunEvent[],
    receiverAgentId: string
): ReadonlyMap<string, ReadonlySet<string>> {
    const hops = new Map<string, Set<string>>();
    for (const event of runEvents) {
        const traceId = stringValue(event.data.traceId);
        const toPeerId = stringValue(event.data.toPeerId);
        if (
            event.agentId === receiverAgentId && event.topic === OUTBOUND_DIAGNOSTICS_TOPIC &&
            event.data.kind === 'rtc-ack-submission' && traceId !== undefined && toPeerId !== undefined
        ) {
            hops.set(traceId, new Set([...(hops.get(traceId) ?? []), toPeerId]));
        }
    }
    return hops;
}

function readReceiptExhausted(
    streams: readonly LiveRtcLayoutSwitchStream[],
    runEvents: readonly LiveRtcRunEvent[]
): LiveRtcLayoutSwitchObservations['receiptExhausted'] {
    return runEvents.filter((event) => JSON.stringify(event.raw).includes('receipt-exhausted')).flatMap((event) => {
        const agent = streams.find((stream) => stream.agentId === event.agentId)?.prefix;
        return agent === undefined
            ? []
            : [{ agent, topic: event.topic ?? 'unknown', kind: stringValue(event.data.kind) ?? null }];
    });
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
