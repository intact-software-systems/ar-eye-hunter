import { isBlackBoxCommandRecord } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RtcDataChannelSendResult } from '@shared/webrtc/qrtc-data-channel.ts';
import type {
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSendObservation
} from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId } from './browser-command-contracts.ts';

export type RtcSendResult = RtcSendDeliveryResult | RtcSendLaneResult;

/** A typed messages.rtc send reports its delivery lifecycle instead of per-peer lane results. */
export interface RtcSendDeliveryResult {
    readonly kind: 'delivery';
    readonly diagnostics: RallarBlackBoxTestRecord;
    readonly state: ALDeliveryState;
    readonly reason: string | undefined;
}

export interface RtcSendLaneResult {
    readonly kind: 'lane';
    readonly diagnostics: RallarBlackBoxTestRecord;
    readonly status: 'sent' | 'no-peers';
    readonly peerResults: readonly RtcSendPeerResult[];
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

export const RTC_SEND_INVALID_RESULT_CODE = 'RALLAR_BB_RTC_INVALID_SEND_RESULT';

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

/** A messages.rtc result must carry a known delivery state and a lane result a known status for every peer. */
export function decodeRtcSendResult(value: unknown): Either<RallarBlackBoxTestError, RtcSendResult> {
    if (!isBlackBoxCommandRecord(value)) {
        return Either.ofLeft({
            code: RTC_SEND_INVALID_RESULT_CODE,
            message: 'The page runtime returned no rtc.send result record.',
            details: value
        });
    }
    return value.transport === 'messages.rtc' ? decodeRtcSendDelivery(value) : decodeRtcSendLane(value);
}

export function toRtcSendStatus(result: RtcSendResult): string {
    return result.kind === 'delivery' ? result.state : result.status;
}

export function toRtcSendFailure(result: RtcSendResult): RallarBlackBoxTestError | undefined {
    if (result.kind === 'delivery') {
        return RTC_SEND_FAILED_DELIVERY_STATES.includes(result.state)
            ? {
                code: 'RALLAR_BB_RTC_SEND_FAILED',
                message: result.reason
                    ? `RTC send failed with status ${result.state}: ${result.reason}`
                    : `RTC send failed with status: ${result.state}.`,
                details: result.diagnostics
            }
            : undefined;
    }
    if (result.status === 'no-peers') {
        return {
            code: 'RALLAR_BB_RTC_NO_PEERS',
            message: 'RTC send resolved no target peers.',
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
    const peerResults = input.result.kind === 'lane' ? input.result.peerResults : [];
    const droppedPayloadCount = peerResults.filter((peer) => peer.status === 'dropped').length;
    const replacedPayloadCount = peerResults.filter((peer) => peer.status === 'replaced').length;
    return {
        commandId: input.command.commandId,
        kind: input.command.kind,
        transport: input.command.transport,
        durationMs: input.durationMs,
        ok: input.ok,
        status,
        queued: status === 'queued',
        droppedPayloadCount: droppedPayloadCount > 0 ? droppedPayloadCount : undefined,
        replacedPayloadCount: replacedPayloadCount > 0 ? replacedPayloadCount : undefined,
        errorCode: input.errorCode
    };
}

function decodeRtcSendDelivery(
    diagnostics: RallarBlackBoxTestRecord
): Either<RallarBlackBoxTestError, RtcSendDeliveryResult> {
    const message = diagnostics.message;
    const state = isBlackBoxCommandRecord(message)
        ? AL_DELIVERY_STATES.find((candidate) => candidate === message.state)
        : undefined;
    const reason = isBlackBoxCommandRecord(message) ? message.reason : undefined;
    if (state === undefined || (reason !== undefined && typeof reason !== 'string')) {
        return toInvalidRtcSendResult(
            'The page runtime returned a messages.rtc result with no known delivery state.',
            diagnostics
        );
    }
    return Either.ofRight({ kind: 'delivery', diagnostics, state, reason });
}

function decodeRtcSendLane(diagnostics: RallarBlackBoxTestRecord): Either<RallarBlackBoxTestError, RtcSendLaneResult> {
    const status = diagnostics.status;
    const results = diagnostics.results;
    if ((status !== 'sent' && status !== 'no-peers') || !Array.isArray(results)) {
        return toInvalidRtcSendResult(
            'The page runtime returned a realtime result with no send status or peer results.',
            diagnostics
        );
    }
    const peerResults = results.flatMap(decodeRtcSendPeerResult);
    return peerResults.length === results.length
        ? Either.ofRight({ kind: 'lane', diagnostics, status, peerResults })
        : toInvalidRtcSendResult('The page runtime returned a realtime peer result with no known status.', diagnostics);
}

function decodeRtcSendPeerResult(entry: unknown): readonly RtcSendPeerResult[] {
    if (!isBlackBoxCommandRecord(entry) || !isBlackBoxCommandRecord(entry.result)) {
        return [];
    }
    const resultStatus = entry.result.status;
    const status = RTC_PEER_RESULT_STATUSES.find((candidate) => candidate === resultStatus);
    return status === undefined ? [] : [{ entry, status }];
}

function toInvalidRtcSendResult<T>(
    message: string,
    diagnostics: RallarBlackBoxTestRecord
): Either<RallarBlackBoxTestError, T> {
    return Either.ofLeft({ code: RTC_SEND_INVALID_RESULT_CODE, message, details: diagnostics });
}
