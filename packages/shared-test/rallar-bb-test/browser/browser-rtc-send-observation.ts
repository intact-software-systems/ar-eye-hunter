import {
    type RtcConnectReadinessResult
} from '../browser/rtc-connect-readiness.ts';

import { RtcSendFailure, RtcSendObservationInput } from './browser-command-contracts.ts';
import { resolveFirstDefined, toBrowserCommandRecord, toStringValue } from './browser-command-values.ts';

export const RTC_FAILURE_STATUSES = new Set([
    'no-peers',
    'no-route',
    'failed',
    'rate-limited',
    'circuit-open',
    'skipped',
    'expired'
]);

export const RTC_DATA_CHANNEL_FAILURE_STATUSES = new Set(['closed', 'dropped']);

export function withSendObservationValue(
    value: unknown,
    sendObservation: Readonly<Record<string, unknown>>
): unknown {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? {
            ...(value as Record<string, unknown>),
            sendObservation
        }
        : {
            diagnostics: value,
            sendObservation
        };
}

export function withRtcConnectReadinessValue(
    value: unknown,
    readiness: RtcConnectReadinessResult
): unknown {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? {
            ...(value as Record<string, unknown>),
            readiness
        }
        : {
            diagnostics: value,
            readiness
        };
}

export function countDataChannelStatuses(
    diagnostics: unknown,
    status: string
): number | undefined {
    const root = toBrowserCommandRecord(diagnostics);
    if (!Array.isArray(root.results)) {
        return undefined;
    }

    const count = root.results.filter((entry) => {
        const result = toBrowserCommandRecord(toBrowserCommandRecord(entry).result);
        return result.status === status;
    }).length;
    return count > 0 ? count : undefined;
}

export function rtcSendObservation(
    input: RtcSendObservationInput
): Readonly<Record<string, unknown>> {
    const root = toBrowserCommandRecord(input.diagnostics);
    const status = toRtcSendStatus(root);
    return {
        commandId: input.command.commandId,
        kind: input.command.kind,
        transport: input.command.transport,
        durationMs: input.durationMs,
        ok: input.ok,
        status,
        queued: status === 'queued' || status === 'buffered',
        enqueued: status === 'enqueued',
        backpressured: status === 'backpressure' ||
            status === 'backpressured' ||
            status === 'rate-limited' ||
            status === 'buffer-full' ||
            status === 'circuit-open',
        droppedPayloadCount: countDataChannelStatuses(input.diagnostics, 'dropped'),
        replacedPayloadCount: resolveFirstDefined([
            typeof root.replacedPayloadCount === 'number'
                ? root.replacedPayloadCount
                : undefined,
            typeof root.replacedCount === 'number' ? root.replacedCount : undefined
        ]),
        errorCode: input.errorCode
    };
}

export function rtcSendFailureFromDiagnostics(
    diagnostics: unknown
): RtcSendFailure | undefined {
    const root = toBrowserCommandRecord(diagnostics);
    const status = toStringValue(root.status);
    if (status && RTC_FAILURE_STATUSES.has(status)) {
        return {
            code: status === 'no-peers'
                ? 'RALLAR_BB_RTC_NO_PEERS'
                : 'RALLAR_BB_RTC_SEND_FAILED',
            message: status === 'no-peers'
                ? 'RTC send resolved no target peers.'
                : `RTC send failed with status: ${status}.`,
            details: diagnostics
        };
    }

    const message = toBrowserCommandRecord(root.message);
    const messageStatus = toStringValue(message.state);
    if (messageStatus && ['rejected', 'failed', 'expired', 'cancelled', 'superseded'].includes(messageStatus)) {
        return {
            code: 'RALLAR_BB_RTC_SEND_FAILED',
            message: message.reason
                ? `RTC send failed with status ${messageStatus}: ${String(message.reason)}`
                : `RTC send failed with status: ${messageStatus}.`,
            details: diagnostics
        };
    }

    const failedResults = Array.isArray(root.results)
        ? root.results.filter((entry) => {
            const result = toBrowserCommandRecord(toBrowserCommandRecord(entry).result);
            const resultStatus = toStringValue(result.status);
            return Boolean(
                resultStatus && RTC_DATA_CHANNEL_FAILURE_STATUSES.has(resultStatus)
            );
        })
        : [];
    if (failedResults.length > 0) {
        return {
            code: 'RALLAR_BB_RTC_PEER_SEND_FAILED',
            message: `RTC send failed for ${failedResults.length} peer(s).`,
            details: {
                diagnostics,
                failedResults
            }
        };
    }

    return undefined;
}

export function toRtcSendStatus(diagnostics: Record<string, unknown>): string | undefined {
    return toStringValue(toBrowserCommandRecord(diagnostics.message).state) ?? toStringValue(diagnostics.status);
}
