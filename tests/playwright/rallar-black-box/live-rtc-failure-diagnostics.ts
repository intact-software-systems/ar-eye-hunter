import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord, stringValue, type LiveRtcJsonRecord } from './live-rtc-evidence-json.ts';
import type {
    LiveRtcFailedControlResult,
    LiveRtcNackSendResultSummary,
    LiveRtcSendResultSummary
} from './live-rtc-performance-evidence.ts';

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
    const diagnostics = result?.ok
        ? jsonRecord(result.result?.value) ?? {}
        : jsonRecord(jsonRecord(result?.error)?.details) ?? {};
    return jsonRecord(diagnostics.message) ?? {};
}

export function summarizeLiveRtcSendResult(
    result: LiveRtcControlClient.Result | undefined
): LiveRtcSendResultSummary | undefined {
    if (!result) {
        return undefined;
    }
    const observation = deliveryObservationOf(result);
    return {
        ok: result.ok,
        state: classifyDeliveryState(stringValue(observation.state)),
        reason: stringValue(observation.reason) === undefined
            ? null
            : stringValue(observation.reason) === 'not-yet-in-sync'
            ? 'not-yet-in-sync'
            : 'other',
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
        state: observation.state === undefined ? null : classifyDeliveryState(stringValue(observation.state)),
        reason: stringValue(observation.reason) === undefined
            ? null
            : stringValue(observation.reason) === 'not-yet-in-sync'
            ? 'not-yet-in-sync'
            : 'other',
        submitted: booleanOrNull(observation.submitted),
        enqueued: booleanOrNull(observation.enqueued),
        backpressured: booleanOrNull(observation.backpressured),
        attempts: numberOrNull(observation.attempts),
        confirmedHopCount: hopCountOrNull(observation.confirmedHopPeerIds),
        unconfirmedHopCount: hopCountOrNull(observation.unconfirmedHopPeerIds)
    };
}
