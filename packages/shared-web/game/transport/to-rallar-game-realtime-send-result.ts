import type { RallarRealtimeSendResult, RallarRoomRealtimeSendResult } from '@shared-web/browser/rallar.ts';
import type { RallarGameSendResult } from './rallar-game-send-result.ts';

/** Translates browser realtime outcomes into the Rallar Game result contract. */
export function toRallarGameRealtimeSendResult(
    realtime: readonly RallarRealtimeSendResult[]
): RallarGameSendResult {
    if (realtime.length === 0) {
        return {
            status: 'not-ready',
            transport: 'realtime',
            realtime,
            reason: 'No realtime peers were targeted.'
        };
    }

    const successfulCount = realtime.filter((entry) =>
        entry.result.status === 'sent' ||
        entry.result.status === 'queued' ||
        entry.result.status === 'replaced'
    ).length;
    if (successfulCount === realtime.length) {
        return { status: 'sent', transport: 'realtime', realtime };
    }
    return {
        status: successfulCount > 0 ? 'partial' : 'not-ready',
        transport: 'realtime',
        realtime,
        reason: successfulCount > 0
            ? 'Some realtime sends did not succeed.'
            : 'Realtime lane is not ready.'
    };
}

export function toRallarGameRoomRealtimeSendResult(
    realtime: RallarRoomRealtimeSendResult
): RallarGameSendResult {
    const common = {
        transport: 'realtime' as const,
        realtime: realtime.results
    };
    const status = realtime.status;
    switch (status) {
        case 'sent':
            return { ...common, status: 'sent' };
        case 'partial':
            return {
                ...common,
                status: 'partial',
                reason: realtime.reason ?? 'Some room realtime sends did not succeed.'
            };
        case 'halted':
            return {
                ...common,
                status: 'stopped',
                reason: realtime.reason ?? 'Room realtime transport is halted.'
            };
        case 'not-ready':
        case 'no-targets':
            return {
                ...common,
                status: 'not-ready',
                reason: realtime.reason ?? 'Room realtime transport is not ready.'
            };
        case 'failed':
            return {
                ...common,
                status: 'failed',
                reason: realtime.reason ?? 'Room realtime send failed.'
            };
    }
    const exhaustiveStatus: never = status;
    return exhaustiveStatus;
}
