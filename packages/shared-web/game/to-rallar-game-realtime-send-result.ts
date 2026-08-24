import type { RallarRealtimeSendResult, RallarRoomRealtimeSendResult } from '@shared-web/browser/rallar.ts';
import type { RallarGameSendResult } from './types.ts';

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
    if (realtime.status === 'sent') {
        return {
            status: 'sent',
            transport: 'realtime',
            realtime: realtime.results
        };
    }

    if (realtime.status === 'partial') {
        return {
            status: 'partial',
            transport: 'realtime',
            realtime: realtime.results,
            reason: realtime.reason ?? 'Some room realtime sends did not succeed.'
        };
    }

    const notReady = realtime.status === 'not-ready' || realtime.status === 'no-targets';
    return {
        status: notReady ? 'not-ready' : 'failed',
        transport: 'realtime',
        realtime: realtime.results,
        reason: realtime.reason ?? (notReady
            ? 'Room realtime transport is not ready.'
            : 'Room realtime send failed.')
    };
}
