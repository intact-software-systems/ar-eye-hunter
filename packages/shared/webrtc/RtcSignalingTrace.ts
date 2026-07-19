import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    QRtcSignalingChannel,
    type QRtcSignalingMessage,
    QRtcSignalingMsgType,
    QRtcSignalingType,
} from './QRtcSignalingContracts.ts';

export const RTC_SIGNALING_TRACE_LOG_PREFIX = 'RTC signaling trace: ';
export const RTC_SIGNALING_TRACE_SCHEMA_VERSION = 1;

export type RtcSignalingTraceStage =
    | 'client-outbox-enqueued'
    | 'client-outbox-sent'
    | 'server-inbox-received'
    | 'server-forwarded'
    | 'client-inbox-received'
    | 'rtc-dispatched';

export type RtcSignalingTraceEvent = Readonly<{
    schemaVersion: typeof RTC_SIGNALING_TRACE_SCHEMA_VERSION;
    stage: RtcSignalingTraceStage;
    messageId: string;
    messageCreatedAtEpochMs: number;
    atEpochMs: number;
    elapsedMs: number;
    signalType: QRtcSignalingType;
    fromId: string;
    toId: string;
    serverReceivedAtEpochMs?: number;
    serverForwardedAtEpochMs?: number;
}>;

export type RtcSignalingTraceResult = Readonly<{
    message: ALMessage;
    event?: RtcSignalingTraceEvent;
}>;

export type RtcSignalingTraceOptions = Readonly<{
    nowMs?: () => number;
    emit?: (event: RtcSignalingTraceEvent) => void;
}>;

export function emitRtcSignalingTrace(
    message: ALMessage,
    stage: RtcSignalingTraceStage,
    options: RtcSignalingTraceOptions = {},
): RtcSignalingTraceResult {
    const result = traceRtcSignalingMessage(
        message,
        stage,
        options.nowMs?.() ?? Date.now(),
    );
    if (result.event) {
        (options.emit ?? emitRtcSignalingTraceToConsole)(result.event);
    }
    return result;
}

function emitRtcSignalingTraceToConsole(event: RtcSignalingTraceEvent): void {
    console.log(`${RTC_SIGNALING_TRACE_LOG_PREFIX}${JSON.stringify(event)}`);
}

export function traceRtcSignalingMessage(
    message: ALMessage,
    stage: RtcSignalingTraceStage,
    atEpochMs: number = Date.now(),
): RtcSignalingTraceResult {
    const signal = readRtcSignalingMessage(message);
    if (!signal) {
        return { message };
    }

    return {
        message,
        event: {
            schemaVersion: RTC_SIGNALING_TRACE_SCHEMA_VERSION,
            stage,
            messageId: message.id.msgId,
            messageCreatedAtEpochMs: message.id.ts,
            atEpochMs,
            elapsedMs: Math.max(0, atEpochMs - message.id.ts),
            signalType: signal.signalType,
            fromId: signal.fromId,
            toId: signal.toId,
            ...(message.diagnostics?.wsRelayTiming
                ? {
                    serverReceivedAtEpochMs:
                        message.diagnostics.wsRelayTiming.receivedAtEpochMs,
                    serverForwardedAtEpochMs:
                        message.diagnostics.wsRelayTiming.forwardedAtEpochMs,
                }
                : {}),
        },
    };
}

export function withRtcSignalingServerReceivedTiming(
    message: ALMessage,
    receivedAtEpochMs: number = Date.now(),
): ALMessage {
    if (!readRtcSignalingMessage(message)) {
        return message;
    }

    return {
        ...message,
        diagnostics: {
            ...message.diagnostics,
            wsRelayTiming: {
                receivedAtEpochMs,
                forwardedAtEpochMs: receivedAtEpochMs,
            },
        },
    };
}

export function withRtcSignalingServerForwardedTiming(
    message: ALMessage,
    forwardedAtEpochMs: number = Date.now(),
): ALMessage {
    if (!readRtcSignalingMessage(message)) {
        return message;
    }

    return {
        ...message,
        diagnostics: {
            ...message.diagnostics,
            wsRelayTiming: {
                receivedAtEpochMs:
                    message.diagnostics?.wsRelayTiming?.receivedAtEpochMs ??
                    forwardedAtEpochMs,
                forwardedAtEpochMs,
            },
        },
    };
}

export function readRtcSignalingMessage(
    message: ALMessage,
): QRtcSignalingMessage | undefined {
    let candidate: unknown;
    try {
        candidate = JSON.parse(message.payload.resource);
    } catch {
        return undefined;
    }

    if (!isRecord(candidate)) {
        return undefined;
    }

    if (
        candidate.channel !== QRtcSignalingChannel.RtcSignal ||
        candidate.type !== QRtcSignalingMsgType.Signal ||
        typeof candidate.fromId !== 'string' ||
        typeof candidate.toId !== 'string' ||
        !isRtcSignalingType(candidate.signalType)
    ) {
        return undefined;
    }

    return candidate as QRtcSignalingMessage;
}

function isRtcSignalingType(value: unknown): value is QRtcSignalingType {
    return value === QRtcSignalingType.Offer ||
        value === QRtcSignalingType.Answer ||
        value === QRtcSignalingType.IceCandidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
