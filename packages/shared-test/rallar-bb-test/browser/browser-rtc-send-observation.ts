import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RtcDataChannelSendResult } from '@shared/webrtc/qrtc-data-channel.ts';
import type {
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId, RallarBlackBoxBrowserRallarRuntimeResult } from './browser-command-contracts.ts';
import { isBrowserCommandRecord } from './browser-command-values.ts';

/** What the page runtime reported about one rtc.send, read from its diagnostics. */
export interface RtcSendResult {
    readonly diagnostics: RallarBlackBoxBrowserRallarRuntimeResult;
    /** The realtime lane's status; a typed messages.rtc send reports its delivery instead. */
    readonly laneStatus: 'sent' | 'no-peers' | undefined;
    /** The messages.rtc handle's lifecycle when the page returned; a realtime-lane send has none. */
    readonly delivery: RtcSendDelivery | undefined;
    readonly peerResults: readonly RtcSendPeerResult[];
}

export interface RtcSendDelivery {
    readonly state: ALDeliveryState;
    readonly reason: string | undefined;
}

export interface RtcSendObservationInput {
    readonly command: Extract<CommandWithId, { kind: 'rtc.send'; }>;
    readonly result: RtcSendResult;
    readonly durationMs: number;
    readonly ok: boolean;
    readonly errorCode: string | undefined;
}

interface RtcSendPeerResult {
    readonly entry: RallarBlackBoxTestRecord;
    readonly status: RtcDataChannelSendResult['status'];
}

/** A lost observation (`unobservable`) is never a failed send. */
const RTC_SEND_FAILED_DELIVERY_STATES: readonly ALDeliveryState[] = [
    'rejected',
    'failed',
    'expired',
    'cancelled',
    'superseded'
];

const RTC_PEER_RESULT_STATUSES: readonly RtcDataChannelSendResult['status'][] = [
    'sent',
    'queued',
    'dropped',
    'replaced',
    'closed',
    'cancelled',
    'expired'
];

const RTC_PEER_SEND_FAILED_STATUSES: readonly RtcDataChannelSendResult['status'][] = ['closed', 'dropped'];

export function decodeRtcSendResult(diagnostics: unknown): RtcSendResult {
    const root = isBrowserCommandRecord(diagnostics) ? diagnostics : {};
    return {
        diagnostics,
        laneStatus: root.status === 'sent' || root.status === 'no-peers' ? root.status : undefined,
        delivery: decodeRtcSendDelivery(root.message),
        peerResults: Array.isArray(root.results) ? root.results.flatMap(decodeRtcSendPeerResult) : []
    };
}

export function toRtcSendStatus(result: RtcSendResult): string | undefined {
    return result.delivery?.state ?? result.laneStatus;
}

export function toRtcSendFailure(result: RtcSendResult): RallarBlackBoxTestError | undefined {
    if (result.laneStatus === 'no-peers') {
        return {
            code: 'RALLAR_BB_RTC_NO_PEERS',
            message: 'RTC send resolved no target peers.',
            details: result.diagnostics
        };
    }
    const delivery = result.delivery;
    if (delivery && RTC_SEND_FAILED_DELIVERY_STATES.includes(delivery.state)) {
        return {
            code: 'RALLAR_BB_RTC_SEND_FAILED',
            message: delivery.reason
                ? `RTC send failed with status ${delivery.state}: ${delivery.reason}`
                : `RTC send failed with status: ${delivery.state}.`,
            details: result.diagnostics
        };
    }
    const failedResults = result.peerResults
        .filter((peer) => RTC_PEER_SEND_FAILED_STATUSES.includes(peer.status))
        .map((peer) => peer.entry);
    return failedResults.length === 0 ? undefined : {
        code: 'RALLAR_BB_RTC_PEER_SEND_FAILED',
        message: `RTC send failed for ${failedResults.length} peer(s).`,
        details: { diagnostics: result.diagnostics, failedResults }
    };
}

export function toRtcSendObservation(input: RtcSendObservationInput): RallarBlackBoxTestSendObservation {
    const status = toRtcSendStatus(input.result);
    const droppedPayloadCount = input.result.peerResults.filter((peer) => peer.status === 'dropped').length;
    return {
        commandId: input.command.commandId,
        kind: input.command.kind,
        transport: input.command.transport,
        durationMs: input.durationMs,
        ok: input.ok,
        status,
        queued: status === 'queued',
        droppedPayloadCount: droppedPayloadCount > 0 ? droppedPayloadCount : undefined,
        errorCode: input.errorCode
    };
}

export function withSendObservationValue(
    diagnostics: RallarBlackBoxBrowserRallarRuntimeResult,
    sendObservation: RallarBlackBoxTestSendObservation
): RallarBlackBoxTestRecord {
    return isBrowserCommandRecord(diagnostics)
        ? { ...diagnostics, sendObservation }
        : { diagnostics, sendObservation };
}

function decodeRtcSendDelivery(message: unknown): RtcSendDelivery | undefined {
    if (!isBrowserCommandRecord(message)) {
        return undefined;
    }
    const state = AL_DELIVERY_STATES.find((candidate) => candidate === message.state);
    return state === undefined
        ? undefined
        : { state, reason: typeof message.reason === 'string' ? message.reason : undefined };
}

function decodeRtcSendPeerResult(entry: unknown): readonly RtcSendPeerResult[] {
    if (!isBrowserCommandRecord(entry) || !isBrowserCommandRecord(entry.result)) {
        return [];
    }
    const resultStatus = entry.result.status;
    const status = RTC_PEER_RESULT_STATUSES.find((candidate) => candidate === resultStatus);
    return status === undefined ? [] : [{ entry, status }];
}
