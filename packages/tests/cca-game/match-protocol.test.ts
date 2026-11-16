import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeTownMatchFrame, validateTownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import type { RallarDirectorStatus } from '../../shared-web/browser/director/rallar-director-facade.ts';

const roomRef = { applicationId: 'cca-2d', workspaceId: 'default', groupId: 'town' };
const director: RallarDirectorStatus = {
    roomRef,
    roomId: 'town',
    role: 'client',
    state: 'fresh',
    isDirector: false,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    lastHeartbeatAtEpochMs: 1000,
    nowEpochMs: 1100,
    appointment: {
        version: 1,
        mode: 'appointed-spa',
        principalId: 'alice',
        sessionId: 'alice-session',
        epoch: 3,
        appointedAtEpochMs: 1000,
        heartbeatTtlMs: 4000
    }
};
const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
];
const frame = {
    protocol: 'cca.match.v1',
    build: 'grumpy-town-v1',
    roomRef,
    epoch: 3,
    matchId: 'round',
    sequence: 12,
    action: { kind: 'controls', x: 1, z: 0, dash: 2 }
};
const reception = { roomRef, targetRoomRef: roomRef, director, members, senderId: 'bob-session', matchId: 'round' };

describe('Rallar match protocol admission', () => {
    it('decodes bounded controls and rejects malformed, oversized and incompatible messages', () => {
        expect(decodeTownMatchFrame(JSON.stringify(frame)).right).toEqual(frame);
        for (
            const invalid of [
                { ...frame, protocol: 'old' },
                { ...frame, build: 'old' },
                { ...frame, epoch: -1 },
                { ...frame, sequence: 1.5 },
                { ...frame, roomRef: { groupId: 'town' } },
                { ...frame, action: { kind: 'controls', x: 2, z: 0, dash: 0 } },
                { ...frame, action: { kind: 'controls', x: 0, z: 0, dash: -1 } },
                { ...frame, action: { kind: 'controls', x: 0, z: 0, dash: 0, playerId: 'alice' } }
            ]
        ) {
            expect(decodeTownMatchFrame(JSON.stringify(invalid)).left).toBeDefined();
        }
        expect(decodeTownMatchFrame('x'.repeat(300_000)).left).toBeDefined();
        expect(decodeTownMatchFrame(frame).left).toBeDefined();
    });

    it('binds messages to authenticated sender, complete room scope and fresh server appointment', () => {
        const decoded = decodeTownMatchFrame(JSON.stringify(frame)).right!;
        expect(validateTownMatchFrame(decoded, reception)).toEqual([]);
        for (
            const invalid of [
                { ...reception, senderId: 'outsider' },
                { ...reception, targetRoomRef: undefined },
                { ...reception, targetRoomRef: { ...roomRef, workspaceId: 'other' } },
                { ...reception, roomRef: { ...roomRef, applicationId: 'other' } },
                { ...reception, director: { ...director, isFresh: false } },
                { ...reception, director: { ...director, appointment: undefined } },
                { ...reception, director: { ...director, appointment: { ...director.appointment!, epoch: 4 } } },
                { ...reception, matchId: 'new-round' }
            ]
        ) {
            expect(validateTownMatchFrame(decoded, invalid).length).toBeGreaterThan(0);
        }
    });

    it('only accepts proposals and commits from the appointed session, while allowing peer acknowledgements', () => {
        for (
            const action of [
                { kind: 'proposal', digest: 'a'.repeat(64), snapshot: '{}' },
                { kind: 'commit', digest: 'a'.repeat(64), proposalSequence: 10 }
            ]
        ) {
            const decoded = decodeTownMatchFrame(JSON.stringify({ ...frame, action })).right!;
            expect(validateTownMatchFrame(decoded, reception).length).toBeGreaterThan(0);
            expect(validateTownMatchFrame(decoded, { ...reception, senderId: 'alice-session' })).toEqual([]);
        }
        const acknowledgement = decodeTownMatchFrame(JSON.stringify({
            ...frame,
            action: { kind: 'ack', digest: 'a'.repeat(64), proposalSequence: 10 }
        })).right!;
        expect(validateTownMatchFrame(acknowledgement, reception)).toEqual([]);
        const firstProposal = decodeTownMatchFrame(JSON.stringify({
            ...frame,
            action: { kind: 'proposal', digest: 'a'.repeat(64), snapshot: '{}' }
        })).right!;
        expect(validateTownMatchFrame(firstProposal, { ...reception, matchId: undefined, senderId: 'alice-session' })).toEqual([]);
        expect(validateTownMatchFrame(acknowledgement, { ...reception, matchId: undefined }).length).toBeGreaterThan(0);
    });
});
