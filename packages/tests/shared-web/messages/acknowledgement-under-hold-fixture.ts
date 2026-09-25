import { expect, onTestFinished, vi, type MockInstance, type MockSettledResult } from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { initialiseRtcOverlayMulticastManager, initialiseRtcRxStreamer } from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALOutboundMessageRuntime, type ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    createScriptedTransportFaultPort,
    type ScriptedTransportFault,
    type ScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { createNativeRtcConnectionFixture, installNativeRtcRuntime } from '../../shared/native-rtc-connection-fixture.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createAcceptedGroupSnapshotFixture, createAcceptedOverlayFixture } from '../authoritative-group-fixtures.ts';
import { setNextAcksReadEvictionRaced } from './acks-read-eviction-race.ts';

/** Queued turns `settle` runs; a count of turns, not a clock. */
export const ACK_UNDER_HOLD_SETTLE_TURNS = 20;

/** The browser sender's default deadline, which outlives the receipt's 2 s × 3-retry schedule. */
export const ACK_UNDER_HOLD_MESSAGE_TTL_MS = 30_000;

/** A deadline that ends inside that retry schedule. */
const SHORT_MESSAGE_TTL_MS = 3_000;

/** One sender page's carrier as the lane composes it, over memory stores, with a scripted hold. */
export interface HoldSender {
    readonly carrier: 'rtc' | 'ws';
    readonly selfPeerId: string;
    /** The carrier's outbound admission store namespace, which prefixes every row it keeps. */
    readonly outboundAdmissionNamespace: string;
    readonly faults: ScriptedTransportFaultPort;
    /** `drop` on RTC, `not-ready` on WS; matches the scenario typeId only, as `toHeldFaultCommands` arms it. */
    readonly hold: ScriptedTransportFault;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
    createMessage(resourceId: string, ttlMs: number): ALMessage;
    /** Opens the registry handle and admits the message; the caller drains. */
    send(message: ALMessage): Promise<RallarMessageHandle>;
    cancel(msgId: string): void;
    drain(): Promise<void>;
    /** Moves the clock the retry schedule reads; never waits on it. */
    advance(ms: number): Promise<void>;
    /** Runs `ACK_UNDER_HOLD_SETTLE_TURNS` queued turns; a chain still pending afterwards is the C3 reading. */
    settle(): Promise<void>;
    /**
     * Raises the frame as the native `message` event on the RTC data channel or the WebSocket the
     * client is connected to, so the carrier's own identity guards run first; does not await admission.
     */
    deliver(frame: ALMessage): void;
    /** The typeId of every frame the fault port was asked about. */
    readFaultedTypeIds(): readonly string[];
    /** The receipt the carrier's outbound admission store retains for a sent message. */
    readPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;
}

/**
 * A lane variable added on top of the hold, to the armed and the unarmed case alike: the submission's
 * own retransmission under the held typeId (`ack-timeout`), the lane's cancel of the held send, or,
 * over IndexedDB only, an expired row in the ACK's read set that a concurrent chain evicts first
 * (`expired-row-evicted`). The three `ack-*-retry-schedule` / `ack-after-retries-exhausted` variables
 * move the ACK's arrival against the receipt's retry schedule, always inside the message deadline.
 */
export type HoldEscalation =
    | 'none'
    | 'ack-timeout'
    | 'cancel-held'
    | 'expired-row-evicted'
    | 'ack-inside-retry-schedule'
    | 'ack-after-retry-schedule'
    | 'ack-after-retries-exhausted';

/** Every carrier, with the hold armed or not, under every lane variable. */
export const ACK_UNDER_HOLD_CASES = (['rtc', 'ws'] as const).flatMap((carrier) =>
    ([false, true] as const).flatMap((armed) => (['none', 'ack-timeout', 'cancel-held'] as const).map((escalation) => [carrier, armed, escalation] as const))
);

/** Every carrier, with the hold armed or not, while a concurrent chain evicts an expired row the ACK read. */
export const ACK_UNDER_CONCURRENT_EVICTION_CASES = (['rtc', 'ws'] as const).flatMap((carrier) =>
    ([false, true] as const).map((armed) => [carrier, armed, 'expired-row-evicted'] as const)
);

/**
 * Every carrier, with the hold armed or not, as the ACK arrives just before the retry schedule ends,
 * after it ended with no retry claimed, or after every retry ran; each inside the message deadline.
 */
export const ACK_AGAINST_RETRY_SCHEDULE_CASES = (['rtc', 'ws'] as const).flatMap((carrier) =>
    ([false, true] as const).flatMap((armed) =>
        (['ack-inside-retry-schedule', 'ack-after-retry-schedule', 'ack-after-retries-exhausted'] as const).map((
            escalation
        ) => [carrier, armed, escalation] as const)
    )
);

/** Where an inbound ACK's admission stopped, read from the two spied hops: a value, never a throw. */
export type ControlAdmissionStop =
    | Readonly<{ stop: 'never-admitted'; }>
    | Readonly<{ stop: 'inbound-threw'; reason: string; }>
    | Readonly<{ stop: 'inbound-unsettled'; }>
    | Readonly<{ stop: 'not-routed'; }>
    | Readonly<{ stop: 'outbound-threw'; reason: string; }>
    | Readonly<{ stop: 'outbound-unsettled'; }>
    | Readonly<{ stop: 'outbound-answered'; result: ALOutboundControlAdmissionResult; }>;

export interface ControlAdmissionWitness {
    readonly inbound: MockInstance<ALInboundMessageRuntime['admitIncomingMessage']>;
    readonly outbound: MockInstance<ALOutboundMessageRuntime<ALOutboundTransportMessage>['acceptControlMessage']>;
}

interface HoldSenderRuntime {
    readonly faults: ScriptedTransportFaultPort;
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly diagnostics: ALInboundRuntimeDiagnosticsEvent[];
    readonly engine: InboxOutboxEngine;
    readonly drain: () => Promise<void>;
}

function createHoldSenderRuntime(): HoldSenderRuntime {
    const engine = new InboxOutboxEngine();
    return {
        faults: createScriptedTransportFaultPort(),
        registry: new BrowserRallarDeliveryRegistry({ nowMs: Date.now, maxEntries: 10, retainTerminalMs: 60_000, cancel: () => {} }),
        diagnostics: [],
        engine,
        drain: captureOutboundWorkRunnable(engine)
    };
}

function toSerializedTypeId(serialized: string): string {
    return String(JSON.parse(serialized)?.payload?.typeId);
}

async function runQueuedTurns(turn: () => Promise<void>): Promise<void> {
    for (let index = 0; index < ACK_UNDER_HOLD_SETTLE_TURNS; index += 1) {
        await turn();
    }
}

const RTC_HOLD: ScriptedTransportFault = {
    faultId: 'hold-rtc',
    carrier: 'rtc',
    action: 'drop',
    remaining: 'until-cleared',
    match: { typeId: 'alm.lifecycle', msgId: undefined, controlType: undefined }
};

const WS_HOLD: ScriptedTransportFault = {
    faultId: 'hold-ws',
    carrier: 'ws',
    action: 'not-ready',
    remaining: 'until-cleared',
    match: { typeId: 'held.message', msgId: undefined, controlType: undefined }
};

export async function openRtcHoldSender(): Promise<HoldSender> {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    configureTestCacheRepositories();
    configureBrowserALRuntimeStores('self', { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const group = createAcceptedGroupSnapshotFixture(['self', 'receiver']);
    groupStateSnapshotsRepository.setGroupStateSnapshot(group);
    overlaysRepository.setAcceptedOverlayById(toScopedOverlayId(group.group), createAcceptedOverlayFixture(group, 1, ['receiver']));
    const runtime = createHoldSenderRuntime();
    const { fixture, channel } = openRtcReceiverPeer(runtime.faults);
    const manager = openRtcSenderOwners(runtime, fixture.service);
    const decideSend = vi.spyOn(runtime.faults, 'decideSend');
    return {
        ...toSharedHoldSenderMembers(runtime, {
            carrier: 'rtc',
            turn: () => new Promise<void>((resolve) => setImmediate(resolve)),
            admit: (message) => manager.enqueueIfAbsent(message)
        }),
        selfPeerId: 'self',
        outboundAdmissionNamespace: resolveBrowserRtcOverlayALOutboundRuntimeStores('self').admissionStore.namespace,
        hold: RTC_HOLD,
        createMessage: createRtcLifecycleMessages(group.group),
        cancel: (msgId) => void manager.cancel(msgId),
        advance: async (ms) => void vi.setSystemTime(Date.now() + ms),
        deliver: (frame) => void channel.receive(JSON.stringify(frame)),
        readFaultedTypeIds: () => decideSend.mock.calls.map(([, serialized]) => toSerializedTypeId(serialized)),
        readPendingAck: (msgId) => resolveBrowserRtcOverlayALOutboundRuntimeStores('self').admissionStore.readPendingAck(msgId)
    };
}

/** The lane's scenario message: a room multicast of the held typeId, acknowledged by `receiver`, in sequence. */
function createRtcLifecycleMessages(groupRef: GroupSnapshot['group']): (resourceId: string, ttlMs: number) => ALMessage {
    let seq = 0;
    return (resourceId, ttlMs) => {
        seq += 1;
        return newALMulticastMessage('self', { topicId: 'room.lifecycle', resourceId, contextId: 'group-1' }, groupRef, 'alm.lifecycle', {
            specimen: resourceId
        }, { ack: 'receiver', reliability: 'at-least-once', seq, ttlMs });
    };
}

function openRtcReceiverPeer(faults: ScriptedTransportFaultPort) {
    const nativeRuntime = installNativeRtcRuntime();
    const fixture = createNativeRtcConnectionFixture({
        sessionId: 'self',
        token: 'fixture-token',
        faultPort: faults,
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc'
    }, nativeRuntime);
    onTestFinished(() => {
        fixture.dispose();
        nativeRuntime.dispose();
    });
    fixture.service.ensurePeerConnectionStarted('receiver', true);
    const nativePeer = fixture.nativePeer('receiver');
    nativePeer.setConnected();
    for (const opened of nativePeer.channels) {
        void opened.open();
    }
    return { fixture, channel: nativePeer.channels[0] };
}

/** The outbound owner and, as `initialise-browser-middleware.ts` adds it, the inbound half on the receiver's channel. */
function openRtcSenderOwners(runtime: HoldSenderRuntime, service: WebRtcConnectionService): WebRtcOverlayMulticastManager {
    const manager = initialiseRtcOverlayMulticastManager({
        qosProvider: undefined,
        outboundSettlements: (event) => runtime.registry.record(event),
        webRtcConnectionService: service,
        qboxEngine: runtime.engine
    });
    const streamer = initialiseRtcRxStreamer({
        webRtcOverlayMulticastManager: manager,
        qboxEngine: runtime.engine,
        clientData: { clientId: 'self', sessionId: 'self', isOnline: true },
        inboundStores: resolveBrowserSessionALInboundRuntimeStores('self'),
        inboundDiagnostics: (event) => runtime.diagnostics.push(event)
    });
    streamer.addPeer(service.readPeer('receiver')!);
    onTestFinished(() => {
        streamer.dispose();
        manager.dispose();
    });
    return manager;
}

export async function openWsHoldSender(): Promise<HoldSender> {
    // fake-indexeddb completes on `setImmediate`, so it stays real, as in `ws-durable-owner-recovery.test.ts`.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('WebSocket', TestWebSocket);
    onTestFinished(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        TestWebSocket.instances.length = 0;
    });
    const sessionId = crypto.randomUUID();
    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
    const runtime = createHoldSenderRuntime();
    const { service, native } = await connectWsQueueBox(runtime, sessionId);
    const readiness = vi.spyOn(runtime.faults, 'decideSubmissionReadiness');
    return {
        ...toSharedHoldSenderMembers(runtime, {
            carrier: 'ws',
            turn: () => vi.advanceTimersByTimeAsync(0).then(() => undefined),
            admit: (message) => service.enqueueOutboxIfAbsent(message)
        }),
        selfPeerId: sessionId,
        outboundAdmissionNamespace: resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.namespace,
        hold: WS_HOLD,
        createMessage: (resourceId, ttlMs) => toWsHeldMessage({ sessionId, resourceId, ttlMs }),
        cancel: (msgId) => void service.cancelOutbox(msgId),
        advance: (ms) => vi.advanceTimersByTimeAsync(ms).then(() => undefined),
        deliver: (frame) => native.receive(JSON.stringify(frame)),
        readFaultedTypeIds: () => readiness.mock.calls.map(([serialized]) => toSerializedTypeId(serialized)),
        readPendingAck: (msgId) => resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.readPendingAck(msgId)
    };
}

/** The `ws-retained-work-fault.test.ts` shape: a durable unicast of the held typeId that `receiver` acknowledges. */
function toWsHeldMessage(input: Readonly<{ sessionId: string; resourceId: string; ttlMs: number; }>): ALMessage {
    const { sessionId, resourceId, ttlMs } = input;
    return {
        ...newALUnicastMessage(sessionId, { topicId: 'held', contextId: 'room', resourceId }, 'receiver', 'held.message', { resourceId }, {
            ttlMs
        }),
        delivery: { reliability: 'at-least-once', ack: 'receiver' }
    };
}

async function connectWsQueueBox(runtime: HoldSenderRuntime, sessionId: string) {
    const connecting = createBrowserWebSocketQueueBox({
        qosProvider: undefined,
        submissionReadinessFaultPort: runtime.faults,
        outboundSettlements: (event) => runtime.registry.record(event),
        inboundDiagnostics: (event) => runtime.diagnostics.push(event),
        newConnectionRequestId: undefined,
        qboxEngine: runtime.engine,
        socket: new JsonWebSocketClient('ws://test', runtime.faults),
        clientData: { clientId: sessionId, sessionId, isOnline: true },
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(sessionId),
        connectTimeoutMs: 0
    });
    await vi.advanceTimersByTimeAsync(0);
    const native = TestWebSocket.instances.at(-1);
    if (!native) {
        throw new Error('Connecting must create a native socket');
    }
    native.open();
    const service = await connecting;
    onTestFinished(() => {
        service.close();
        runtime.engine.stop();
    });
    return { service, native };
}

interface HoldSenderCarrierInput {
    readonly carrier: HoldSender['carrier'];
    /** One queued turn of this carrier's scheduler; `settle` runs a fixed count of them. */
    readonly turn: () => Promise<void>;
    readonly admit: (message: ALMessage) => Promise<ALOutboundEnqueueResult>;
}

function toSharedHoldSenderMembers(
    runtime: HoldSenderRuntime,
    input: HoldSenderCarrierInput
): Pick<HoldSender, 'carrier' | 'faults' | 'diagnostics' | 'send' | 'drain' | 'settle'> {
    return {
        carrier: input.carrier,
        faults: runtime.faults,
        diagnostics: runtime.diagnostics,
        send: async (message) => {
            const handle = runtime.registry.open(message, input.carrier);
            await input.admit(message);
            return handle;
        },
        drain: runtime.drain,
        settle: () => runQueuedTurns(input.turn)
    };
}

export function watchControlAdmission(): ControlAdmissionWitness {
    return {
        inbound: vi.spyOn(ALInboundMessageRuntime.prototype, 'admitIncomingMessage'),
        outbound: vi.spyOn(ALOutboundMessageRuntime.prototype, 'acceptControlMessage')
    };
}

export function readControlAdmissionStop(witness: ControlAdmissionWitness, ack: ALMessage): ControlAdmissionStop {
    const inbound = readSettledCall(
        witness.inbound.mock.calls.map(([value]) => value),
        witness.inbound.mock.settledResults,
        (value) => decodeALMessageValue(value).right?.id.msgId === ack.id.msgId
    );
    const outbound = readSettledCall(
        witness.outbound.mock.calls.map(([msg]) => msg),
        witness.outbound.mock.settledResults,
        (msg) => msg.id.msgId === ack.id.msgId
    );
    if (inbound === undefined) {
        return { stop: 'never-admitted' };
    }
    if (outbound === undefined) {
        return toInboundStop(inbound);
    }
    switch (outbound.type) {
        case 'rejected':
            return { stop: 'outbound-threw', reason: String(outbound.value) };
        case 'incomplete':
            return { stop: 'outbound-unsettled' };
        case 'fulfilled':
            return { stop: 'outbound-answered', result: outbound.value };
    }
}

function toInboundStop<TValue>(inbound: MockSettledResult<TValue>): ControlAdmissionStop {
    switch (inbound.type) {
        case 'rejected':
            return { stop: 'inbound-threw', reason: String(inbound.value) };
        case 'incomplete':
            return { stop: 'inbound-unsettled' };
        case 'fulfilled':
            return { stop: 'not-routed' };
    }
}

/** A spy records each call's settlement at the call's own index, so the first matching call names it. */
function readSettledCall<TFirst, TValue>(
    firstArguments: readonly TFirst[],
    settledResults: readonly MockSettledResult<TValue>[],
    matches: (first: TFirst) => boolean
): MockSettledResult<TValue> | undefined {
    const index = firstArguments.findIndex(matches);
    return index < 0 ? undefined : settledResults[index];
}

export function toReceiverAck(submission: ALMessage, sender: Pick<HoldSender, 'selfPeerId' | 'carrier'>): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${submission.id.msgId}`, senderId: 'receiver', ts: Date.now() },
        {
            ackedMsgId: submission.id.msgId,
            originPeerId: sender.selfPeerId,
            logicalRecipientPeerId: 'receiver',
            fromPeerId: 'receiver',
            toPeerId: sender.selfPeerId,
            status: 'accepted',
            observedAtEpochMs: Date.now(),
            carrier: sender.carrier
        }
    );
}

/** The submission is sent before the hold; a second send of its typeId is held while the ACK arrives. */
export async function expectAcknowledgedUnderHold(
    sender: HoldSender,
    armed: boolean,
    escalation: HoldEscalation
): Promise<void> {
    const witness = watchControlAdmission();
    const submission = sender.createMessage('submission', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
    const handle = await sender.send(submission);
    await sender.drain();
    if (armed) {
        sender.faults.inject(sender.hold);
    }
    const held = sender.createMessage('held', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
    await sender.send(held);
    await sender.drain();
    await sender.advance(100);
    await runHoldEscalation(sender, escalation, { submission, held });
    const ack = toReceiverAck(submission, sender);
    expect(handle.lifecycle().expiresAtMs).toBeGreaterThan(Date.now());
    const retried = sender.drain();
    sender.deliver(ack);
    await retried;
    await sender.settle();
    // One more batch: a conflicted control is retained as `admit-control` work, and its replay is the value path.
    await sender.drain();
    await sender.settle();

    expect(sender.faults.getObservations().length > 0).toBe(armed);
    // A conflict with a concurrent ack-timeout claim answers `pending-control`, and its replay acknowledges.
    expect(readControlAdmissionStop(witness, ack)).toEqual({
        stop: 'outbound-answered',
        result: { kind: expect.stringMatching(/^(committed|pending-control)$/) }
    });
    expect(sender.diagnostics).toContainEqual(expect.objectContaining({
        kind: 'admission-outcome',
        msgId: ack.id.msgId,
        typeId: AL_CONTROL_ACK_TYPE_ID,
        reason: 'control'
    }));
    expect(handle.lifecycle().state).toBe('acknowledged');
    expect(sender.readFaultedTypeIds()).not.toContain(AL_CONTROL_ACK_TYPE_ID);
}

/** Without an ACK inside the deadline the send ends `expired`, and an ACK after it is refused. */
export async function expectExpiredPastTheDeadline(sender: HoldSender): Promise<void> {
    const witness = watchControlAdmission();
    const submission = sender.createMessage('submission', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
    const handle = await sender.send(submission);
    await sender.drain();
    await runAckTimeoutClaimsToExhaustion(sender, submission.id.msgId);
    const deadlineMs = handle.lifecycle().expiresAtMs;
    if (deadlineMs === undefined) {
        throw new Error(`No deadline for ${submission.id.msgId}`);
    }
    await sender.advance(deadlineMs - Date.now() + 1);
    await sender.drain();
    const ack = toReceiverAck(submission, sender);
    sender.deliver(ack);
    await sender.settle();

    expect(readControlAdmissionStop(witness, ack)).toMatchObject({ stop: 'outbound-answered', result: { kind: 'rejected' } });
    expect(await sender.readPendingAck(submission.id.msgId)).toBeUndefined();
    expect(handle.lifecycle()).toMatchObject({ state: 'expired', evidence: { confirmedHopPeerIds: [] } });
}

/**
 * A deadline that ends before the receipt's retry schedule ends the obligation with it: an ACK after
 * the deadline, though inside that schedule, is refused and the send ends `expired`.
 */
export async function expectRefusedPastAShortDeadline(sender: HoldSender): Promise<void> {
    const witness = watchControlAdmission();
    const submission = sender.createMessage('submission', SHORT_MESSAGE_TTL_MS);
    const handle = await sender.send(submission);
    await sender.drain();
    const deadlineMs = handle.lifecycle().expiresAtMs ?? 0;
    expect(await readRetryScheduleEndMs(sender, submission.id.msgId)).toBeGreaterThan(deadlineMs + 2_000);
    await sender.advance(deadlineMs + 2_000 - Date.now());
    const ack = toReceiverAck(submission, sender);
    sender.deliver(ack);
    await sender.settle();
    await sender.drain();
    await sender.settle();

    expect(readControlAdmissionStop(witness, ack)).toEqual({
        stop: 'outbound-answered',
        result: { kind: 'rejected', reason: expect.stringContaining('AL acknowledgement') }
    });
    expect(handle.lifecycle()).toMatchObject({ state: 'expired', evidence: { confirmedHopPeerIds: [] } });
}

async function runHoldEscalation(
    sender: HoldSender,
    escalation: HoldEscalation,
    sent: Readonly<{ submission: ALMessage; held: ALMessage; }>
): Promise<void> {
    const msgId = sent.submission.id.msgId;
    switch (escalation) {
        case 'none':
            return;
        case 'ack-timeout':
            return await runAckTimeoutClaim(sender, msgId);
        case 'cancel-held':
            return sender.cancel(sent.held.id.msgId);
        case 'expired-row-evicted':
            return await setNextAcksReadEvictionRaced(sender.outboundAdmissionNamespace, msgId);
        case 'ack-inside-retry-schedule':
            return await advanceToRetryScheduleEnd(sender, await readRetryScheduleEndMs(sender, msgId), -1_000);
        case 'ack-after-retry-schedule':
            return await advanceToRetryScheduleEnd(sender, await readRetryScheduleEndMs(sender, msgId), 2_000);
        case 'ack-after-retries-exhausted': {
            const endMs = await readRetryScheduleEndMs(sender, msgId);
            await runAckTimeoutClaimsToExhaustion(sender, msgId);
            return await advanceToRetryScheduleEnd(sender, endMs, 2_000);
        }
    }
}

/** The receipt's retry schedule ends when its last `ack-timeout` window closes: one timeout per attempt left. */
async function readRetryScheduleEndMs(sender: HoldSender, msgId: string): Promise<number> {
    const pending = await sender.readPendingAck(msgId);
    if (pending === undefined) {
        throw new Error(`No pending receipt for ${msgId}`);
    }
    return pending.deadlineAtMs + pending.timeoutMs * (pending.maxAttempts - pending.attempts + 1);
}

async function advanceToRetryScheduleEnd(sender: HoldSender, endMs: number, offsetMs: number): Promise<void> {
    await sender.advance(Math.max(0, endMs + offsetMs - Date.now()));
}

/** Every `ack-timeout` claim the budget allows runs, and the one after it finds the budget spent. */
async function runAckTimeoutClaimsToExhaustion(sender: HoldSender, msgId: string): Promise<void> {
    const before = await sender.readPendingAck(msgId);
    if (before === undefined) {
        throw new Error(`No pending receipt for ${msgId}`);
    }
    for (let claim = 0; claim <= before.maxAttempts; claim += 1) {
        await sender.advance(before.timeoutMs + 1);
        await sender.drain();
        await sender.settle();
    }
}

/** E1: past the receipt's timeout the ack-timeout claim retransmits under the scenario typeId. */
async function runAckTimeoutClaim(sender: HoldSender, msgId: string): Promise<void> {
    const before = await sender.readPendingAck(msgId);
    if (before === undefined) {
        throw new Error(`No pending receipt for ${msgId}`);
    }
    await sender.advance(before.timeoutMs + 1);
    for (let batch = 0; batch < ACK_UNDER_HOLD_SETTLE_TURNS; batch += 1) {
        await sender.drain();
        const after = await sender.readPendingAck(msgId);
        if (after === undefined || after.attempts > before.attempts) {
            return;
        }
    }
    throw new Error(`The ack-timeout claim for ${msgId} never ran`);
}
