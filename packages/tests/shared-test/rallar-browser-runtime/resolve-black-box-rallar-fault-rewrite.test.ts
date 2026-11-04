import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveBlackBoxRallarFaultRewrite } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-fault-rewrite.ts';
import type { GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import { toRoomRosterSession } from './browser-runtime-facade-test-double.ts';

const CHARLIE_KEY = {
    keyId: 'charlie-key-id',
    publicJwk: { kty: 'EC', crv: 'P-256', x: 'charlie-x', y: 'charlie-y' }
} as const;

const forgeCharlie = { forgeSender: { principal: 'principal-charlie' } } as const;

function toSnapshot(activeSessions: readonly GroupPresenceSession[]): GroupSnapshot {
    return {
        ...createGroupSnapshotFixture({ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1', sessionIds: [] }),
        activeSessions
    };
}

describe('the forged sender a rewrite fault names', () => {
    const nowMs = Date.now();

    it('resolves the principal to its one live session and the key that session registered', () => {
        const snapshot = toSnapshot([
            toRoomRosterSession('alice-session', { principalId: 'principal-alice' }),
            { ...toRoomRosterSession('charlie-session', { principalId: 'principal-charlie' }), publicationKey: CHARLIE_KEY },
            toRoomRosterSession('charlie-left', { principalId: 'principal-charlie', status: 'disconnected' }),
            toRoomRosterSession('charlie-lapsed', { principalId: 'principal-charlie', expiresAtEpochMs: nowMs })
        ]);

        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: forgeCharlie, snapshot, nowMs }).right).toEqual({
            kind: 'forge-sender',
            senderId: 'charlie-session',
            keyId: 'charlie-key-id'
        });
        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: 'strip-proof', snapshot: undefined, nowMs }).right)
            .toEqual({ kind: 'strip-proof' });
    });

    it('states, as a value, a principal the page cannot forge: no snapshot, no one live session, no registered key', () => {
        const twoSessions = toSnapshot([
            { ...toRoomRosterSession('charlie-a', { principalId: 'principal-charlie' }), publicationKey: CHARLIE_KEY },
            { ...toRoomRosterSession('charlie-b', { principalId: 'principal-charlie' }), publicationKey: CHARLIE_KEY }
        ]);
        const keyless = toSnapshot([toRoomRosterSession('charlie-session', { principalId: 'principal-charlie' })]);

        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: forgeCharlie, snapshot: undefined, nowMs }).left)
            .toBe('the page holds no snapshot of the room');
        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: forgeCharlie, snapshot: twoSessions, nowMs }).left)
            .toBe('the room holds 2 live sessions of principal-charlie, not exactly one');
        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: forgeCharlie, snapshot: toSnapshot([]), nowMs }).left)
            .toBe('the room holds 0 live sessions of principal-charlie, not exactly one');
        expect(resolveBlackBoxRallarFaultRewrite({ rewrite: forgeCharlie, snapshot: keyless, nowMs }).left)
            .toBe('session charlie-session of principal-charlie registered no publication key');
    });
});
