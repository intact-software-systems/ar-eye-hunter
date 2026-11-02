import { expect, it } from 'vitest';

import { decodeAdminRoomTopologyWork } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';

const request = {
    roomRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' },
    outboxId: 'request-1:rtc-topology-recompute:explicit'
};
const pending = { ...request, observedAtEpochMs: 10_000, status: 'pending', attempts: 1, settledAtEpochMs: null };

it('distinguishes retained pending, completed and failed work from unavailable evidence', () => {
    for (
        const result of [
            pending,
            { ...pending, status: 'completed', settledAtEpochMs: 9_999 },
            { ...pending, status: 'failed' },
            { ...pending, status: 'unknown', attempts: null }
        ]
    ) {
        expect(decodeAdminRoomTopologyWork(result, request)).toEqual(result);
    }
});

it('rejects outcomes for another room, scope or command instead of claiming recovery', () => {
    for (
        const patch of [
            { outboxId: 'another-command' },
            { roomRef: { ...request.roomRef, groupId: 'other' } },
            { roomRef: { ...request.roomRef, workspaceId: 'other' } },
            { roomRef: { ...request.roomRef, applicationId: 'other' } }
        ]
    ) {
        expect(() => decodeAdminRoomTopologyWork({ ...pending, ...patch }, request)).toThrow();
    }
});

it('rejects contradictory, malformed or incomplete outcome evidence', () => {
    for (
        const patch of [
            { status: 'completed' },
            { status: 'unknown' },
            { attempts: null },
            { attempts: -1 },
            { attempts: 1.5 },
            { attempts: '1' },
            { settledAtEpochMs: 9_000 },
            { observedAtEpochMs: -1 },
            { extra: 'undocumented' },
            { status: 'recovered' }
        ]
    ) {
        expect(() => decodeAdminRoomTopologyWork({ ...pending, ...patch }, request)).toThrow();
    }
});
