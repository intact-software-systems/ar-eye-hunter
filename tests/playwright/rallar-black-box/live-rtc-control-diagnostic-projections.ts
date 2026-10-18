import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import type { LiveRtcAgentDiagnostics } from './live-rtc-agent-diagnostics.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    stringValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';
import type {
    LiveRtcDiagnosticFailure,
    LiveRtcFailedControlResult,
    LiveRtcFailureAgentHealth,
    LiveRtcMessageFailureAgentHealth,
    LiveRtcMessageFailureDiagnostic,
    LiveRtcMessageFailureEventSummary,
    LiveRtcMessageFailureResultSummary,
    LiveRtcNackEventClassification,
    LiveRtcNackResultClassification,
    LiveRtcNackSendResultSummary,
    LiveRtcSendResultSummary
} from './live-rtc-performance-evidence.ts';

interface ToMessageFailureDiagnosticInput {
    readonly waitForMessage: LiveRtcControlClient.WaitForMessageInput;
    readonly healthByAgentId: Readonly<Record<string, LiveRtcMessageFailureAgentHealth>>;
    readonly runCapture: LiveRtcControlClient.RunCapture;
    readonly capturedAtEpochMs: number;
}

const MESSAGE_DELIVERY_FAILURE: LiveRtcDiagnosticFailure = {
    name: 'message-delivery-failed',
    message: 'RTC message delivery observation failed.'
};

const HEALTH_CAPTURE_FAILURE: LiveRtcDiagnosticFailure = {
    name: 'health-capture-failed',
    message: 'RTC health diagnostic capture failed.'
};

const MAX_RETAINED_MESSAGE_FAILURE_OBSERVATIONS = 100;

export function messageData(event: LiveRtcControlClient.Event): LiveRtcJsonRecord {
    const runtimeEvent = jsonRecord(event.payload);
    const runtimePayload = jsonRecord(runtimeEvent?.payload);
    return jsonRecord(runtimePayload?.data) ?? {};
}

export function summarizeLiveRtcFailureAgentHealth(
    diagnostics: LiveRtcAgentDiagnostics
): LiveRtcFailureAgentHealth {
    return {
        captureSucceeded: true,
        commandSucceeded: true,
        settledPeerCount: diagnostics.settledPeerIds.length,
        readyPeerCount: diagnostics.readyPeerIds.length,
        laneCount: diagnostics.laneStates.length,
        openLaneCount: diagnostics.laneStates.filter((lane) => lane.isOpen).length,
        reconnectableLaneCount: diagnostics.laneStates.filter(
            (lane) => lane.isReconnectable
        ).length,
        connectionTimerActive: diagnostics.connectionTimerActive,
        peerCount: diagnostics.peerCount,
        connectedPeerCount: diagnostics.connectedPeerCount,
        relayPeerCount: diagnostics.relayPeerCount
    };
}

export function summarizeMessageFailureAgentHealth(
    diagnostics: LiveRtcAgentDiagnostics
): LiveRtcMessageFailureAgentHealth {
    return {
        ...summarizeLiveRtcFailureAgentHealth(diagnostics),
        captureFailure: null
    };
}

export function unavailableLiveRtcFailureAgentHealth(
    captureSucceeded: boolean,
    commandSucceeded: boolean | null
): LiveRtcFailureAgentHealth {
    return {
        captureSucceeded,
        commandSucceeded,
        settledPeerCount: null,
        readyPeerCount: null,
        laneCount: null,
        openLaneCount: null,
        reconnectableLaneCount: null,
        connectionTimerActive: null,
        peerCount: null,
        connectedPeerCount: null,
        relayPeerCount: null
    };
}

export function unavailableMessageFailureAgentHealth(
    captureSucceeded: boolean,
    commandSucceeded: boolean | null
): LiveRtcMessageFailureAgentHealth {
    return {
        ...unavailableLiveRtcFailureAgentHealth(captureSucceeded, commandSucceeded),
        captureFailure: captureSucceeded ? null : HEALTH_CAPTURE_FAILURE
    };
}

export function toMessageFailureDiagnostic(
    input: ToMessageFailureDiagnosticInput
): LiveRtcMessageFailureDiagnostic {
    const run = input.runCapture.run;
    return {
        kind: 'message-delivery-failure',
        runId: input.waitForMessage.runId,
        senderAgentId: input.waitForMessage.senderAgentId,
        receiverAgentId: input.waitForMessage.agentId,
        transport: input.waitForMessage.transport,
        matrixId: input.waitForMessage.matrixId,
        deliveryMode: input.waitForMessage.deliveryMode,
        capturedAtEpochMs: input.capturedAtEpochMs,
        failure: MESSAGE_DELIVERY_FAILURE,
        healthByAgentId: input.healthByAgentId,
        runCaptureSucceeded: input.runCapture.succeeded,
        sendResult: summarizeLiveRtcSendResult(
            (run?.results ?? []).find(
                (result) =>
                    result.agentId === input.waitForMessage.senderAgentId &&
                    result.commandId === `send-${input.waitForMessage.matrixId}`
            )
        ) ?? null,
        recentResults: (run?.results ?? [])
            .slice(-MAX_RETAINED_MESSAGE_FAILURE_OBSERVATIONS)
            .map((result): LiveRtcMessageFailureResultSummary => ({
                agentId: result.agentId ?? null,
                commandId: result.commandId,
                ok: result.ok
            })),
        recentEvents: (run?.events ?? [])
            .slice(-MAX_RETAINED_MESSAGE_FAILURE_OBSERVATIONS)
            .map(summarizeMessageFailureEvent)
    };
}

export function classifyNackEvent(
    event: LiveRtcControlClient.Event,
    input: LiveRtcControlClient.CaptureNackFailureInput
): LiveRtcNackEventClassification {
    const runtimeEvent = jsonRecord(event.payload) ?? {};
    const data = messageData(event);
    return {
        agentRole: classifyNackAgentRole(event.agentId, input),
        kind: classifyNackEventKind(stringValue(runtimeEvent.kind) ?? event.kind),
        transport: classifyNackTransport(stringValue(runtimeEvent.transport)),
        topicPresent: stringValue(runtimeEvent.topic) !== undefined,
        matrixIdPresent: stringValue(data.matrixId) !== undefined,
        deliveryMode: classifyNackDeliveryMode(stringValue(data.deliveryMode))
    };
}

export function classifyNackResult(
    result: LiveRtcControlClient.Result,
    input: LiveRtcControlClient.CaptureNackFailureInput
): LiveRtcNackResultClassification {
    return {
        agentRole: classifyNackAgentRole(result.agentId, input),
        commandRole: result.commandId === input.commandId
            ? 'probe'
            : result.commandId.startsWith('health-nack-failure-')
            ? 'health'
            : 'other',
        ok: result.ok
    };
}

function classifyNackAgentRole(
    agentId: string | undefined,
    input: LiveRtcControlClient.CaptureNackFailureInput
): LiveRtcNackEventClassification['agentRole'] {
    if (agentId === undefined) {
        return 'missing';
    }
    if (agentId === input.senderAgentId) {
        return 'sender';
    }
    return agentId === input.targetAgentId ? 'target' : 'other';
}

function classifyNackEventKind(
    value: string | undefined
): LiveRtcNackEventClassification['kind'] {
    return value === undefined
        ? 'missing'
        : value === 'message'
        ? 'message'
        : 'other';
}

function classifyNackTransport(
    value: string | undefined
): LiveRtcNackEventClassification['transport'] {
    if (value === 'realtime' || value === 'messages.rtc') {
        return value;
    }
    return value === undefined ? 'missing' : 'other';
}

function classifyNackDeliveryMode(
    value: string | undefined
): LiveRtcNackEventClassification['deliveryMode'] {
    return value === undefined ? 'missing' : value === 'nack' ? 'nack' : 'other';
}

function summarizeMessageFailureEvent(
    event: LiveRtcControlClient.Event
): LiveRtcMessageFailureEventSummary {
    const runtimeEvent = jsonRecord(event.payload) ?? {};
    const data = messageData(event);
    return {
        agentId: event.agentId ?? null,
        kind: stringValue(runtimeEvent.kind) ?? event.kind ?? null,
        transport: stringValue(runtimeEvent.transport) ?? null,
        topic: stringValue(runtimeEvent.topic) ?? null,
        matrixId: stringValue(data.matrixId) ?? null,
        deliveryMode: stringValue(data.deliveryMode) ?? null
    };
}

export function summarizeNackSendResult(
    result: LiveRtcControlClient.Result | undefined,
    probeMessageId: string | null
): LiveRtcNackSendResultSummary | undefined {
    if (!result) {
        return undefined;
    }
    const summary = summarizeLiveRtcSendResult(result);
    if (!summary) {
        return undefined;
    }
    return {
        ...summary,
        messageIdMatchesProbe: probeMessageId === null
            ? null
            : messageIdFromSendResult(result) === probeMessageId
    };
}

/** Classifies a raw JSON string against the canonical `ALDeliveryState` union; never a hand-copied list. */
function classifyDeliveryState(
    value: string | undefined
): ALDeliveryState | 'other' | 'missing' {
    if (value === undefined) {
        return 'missing';
    }
    return AL_DELIVERY_STATES.find((candidate) => candidate === value) ?? 'other';
}

function booleanOrNull(value: RtcBaselineJson | undefined): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function numberOrNull(value: RtcBaselineJson | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hopCountOrNull(value: RtcBaselineJson | undefined): number | null {
    return Array.isArray(value) ? value.length : null;
}

/** The `message` field of a `messages.rtc` send diagnostic: the delivery observation, or `{}` when absent. */
function deliveryObservationOf(result: LiveRtcControlClient.Result | undefined): LiveRtcJsonRecord {
    const diagnostics = jsonRecord(result?.result?.value) ?? {};
    return jsonRecord(diagnostics.message) ?? {};
}

function summarizeLiveRtcSendResult(
    result: LiveRtcControlClient.Result | undefined
): LiveRtcSendResultSummary | undefined {
    if (!result) {
        return undefined;
    }
    const observation = deliveryObservationOf(result);
    return {
        ok: result.ok,
        state: classifyDeliveryState(stringValue(observation.state)),
        reason: stringValue(observation.reason) ?? null,
        messageIdPresent: messageIdFromSendResult(result) !== undefined,
        submitted: booleanOrNull(observation.submitted),
        enqueued: booleanOrNull(observation.enqueued),
        backpressured: booleanOrNull(observation.backpressured),
        attempts: numberOrNull(observation.attempts),
        confirmedHopCount: hopCountOrNull(observation.confirmedHopPeerIds),
        unconfirmedHopCount: hopCountOrNull(observation.unconfirmedHopPeerIds)
    };
}

/** The handle id IS the message id: see the producer call at `black-box-rallar-rtc-send-controller.ts`. */
export function messageIdFromSendResult(
    result: LiveRtcControlClient.Result
): string | undefined {
    return stringValue(deliveryObservationOf(result).handleId);
}

export function toFailedControlResult(
    result: LiveRtcControlClient.Result & { ok: false; }
): LiveRtcFailedControlResult {
    const observation = deliveryObservationOf(result);
    return {
        agentId: result.agentId ?? null,
        commandId: result.commandId,
        ok: false,
        state: stringValue(observation.state) ?? null,
        reason: stringValue(observation.reason) ?? null,
        submitted: booleanOrNull(observation.submitted),
        enqueued: booleanOrNull(observation.enqueued),
        backpressured: booleanOrNull(observation.backpressured),
        attempts: numberOrNull(observation.attempts),
        confirmedHopCount: hopCountOrNull(observation.confirmedHopPeerIds),
        unconfirmedHopCount: hopCountOrNull(observation.unconfirmedHopPeerIds)
    };
}
