import { describe, expect, it } from 'vitest';

import type { RallarRealtimeSendResult, RallarRoomRealtimeSendResult } from '@shared-web/browser/rallar.ts';
import { toRallarGameRealtimeSendResult, toRallarGameRoomRealtimeSendResult } from '@shared-web/game/transport/to-rallar-game-realtime-send-result.ts';

const sent: RallarRealtimeSendResult = {
    peerId: 'peer-1',
    laneId: 'gameplay',
    result: { status: 'sent', bufferedAmount: 0 }
};

const unavailable: RallarRealtimeSendResult = {
    peerId: 'peer-2',
    laneId: 'gameplay',
    result: { status: 'closed', bufferedAmount: 0 }
};

describe('Rallar Game realtime send results', () => {
    it('reports complete, partial, unavailable and untargeted direct delivery', () => {
        expect(toRallarGameRealtimeSendResult([sent])).toEqual({
            status: 'sent',
            transport: 'realtime',
            realtime: [sent]
        });
        expect(toRallarGameRealtimeSendResult([sent, unavailable])).toEqual({
            status: 'partial',
            transport: 'realtime',
            realtime: [sent, unavailable],
            reason: 'Some realtime sends did not succeed.'
        });
        expect(toRallarGameRealtimeSendResult([unavailable])).toMatchObject({ status: 'not-ready' });
        expect(toRallarGameRealtimeSendResult([])).toMatchObject({ status: 'not-ready' });
    });

    it.each(
        [
            ['sent', 'sent', undefined],
            ['partial', 'partial', 'Some room realtime sends did not succeed.'],
            ['halted', 'stopped', 'Room realtime transport is halted.'],
            ['not-ready', 'not-ready', 'Room realtime transport is not ready.'],
            ['no-targets', 'not-ready', 'Room realtime transport is not ready.'],
            ['failed', 'failed', 'Room realtime send failed.']
        ] as const
    )('maps room %s to game %s while preserving individual results', (status, gameStatus, reason) => {
        const roomResult: RallarRoomRealtimeSendResult = {
            transport: 'rtc',
            status,
            laneId: 'gameplay',
            peerIds: ['peer-1'],
            desiredPeerIds: ['peer-1'],
            results: [sent]
        };
        const result = toRallarGameRoomRealtimeSendResult(roomResult);

        expect(result).toEqual({
            status: gameStatus,
            transport: 'realtime',
            realtime: [sent],
            ...(reason ? { reason } : {})
        });
    });

    it('preserves the authoritative halt explanation', () => {
        expect(toRallarGameRoomRealtimeSendResult({
            transport: 'rtc',
            status: 'halted',
            laneId: 'gameplay',
            peerIds: [],
            desiredPeerIds: [],
            results: [],
            reason: 'Room paused by its owner.'
        })).toEqual({
            status: 'stopped',
            transport: 'realtime',
            realtime: [],
            reason: 'Room paused by its owner.'
        });
    });
});
