import type { RallarRealtimeSendResult, RallarRoomRealtimeSendResult } from '@shared-web/browser/rallar.ts';
import { toRallarGameRealtimeSendResult, toRallarGameRoomRealtimeSendResult } from '@shared-web/game/to-rallar-game-realtime-send-result.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar Game realtime send results', () => {
    it('omits a failure reason when every direct realtime send succeeds', () => {
        const result = toRallarGameRealtimeSendResult([
            toTestDouble<RallarRealtimeSendResult>({
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: { status: 'sent', bufferedAmount: 0 }
            })
        ]);

        expect(result).toMatchObject({ status: 'sent', transport: 'realtime' });
        expect(result).not.toHaveProperty('reason');
    });

    it('omits a failure reason when the room realtime send succeeds', () => {
        const result = toRallarGameRoomRealtimeSendResult(
            toTestDouble<RallarRoomRealtimeSendResult>({
                status: 'sent',
                results: []
            })
        );

        expect(result).toMatchObject({ status: 'sent', transport: 'realtime' });
        expect(result).not.toHaveProperty('reason');
    });
});

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
