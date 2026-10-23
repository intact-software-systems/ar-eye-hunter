import { describe, expect, it } from 'vitest';

import { computeGroupDirectoryPage } from '@shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts';
import { decodeGroupDirectoryQuery } from '@shared-server/rallar-system/group-state/directory/decode-group-directory-query.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshot } from '../snapshot/group-state-snapshot-test-fixtures.ts';

interface DirectoryPageInput {
    readonly rooms: readonly GroupSnapshot[];
    readonly search: string;
    readonly rttMeasurements: readonly RttMeasurementInfo[];
    readonly requesterSessionId?: string | null;
}

const NOW = 100_000;
const snapshots = [
    createRoomSnapshot('a-slow', ['slow-1', 'slow-2']),
    createRoomSnapshot('b-unknown', ['unknown-1', 'unknown-2']),
    createRoomSnapshot('z-fast', ['fast-1', 'fast-2'])
];
const measurements = [
    createRttMeasurement('slow-1', 60),
    createRttMeasurement('slow-2', 90),
    createRttMeasurement('fast-1', 12),
    createRttMeasurement('fast-2', 20)
];

describe('directory measured peer RTT', () => {
    it('keeps occupancy first and uses the slowest fully measured peer only when requested', () => {
        const rooms = [...snapshots, createRoomSnapshot('crowded', ['c-1', 'c-2', 'c-3'])];
        const ordinary = computeDirectoryPage({ rooms, search: '', rttMeasurements: measurements });
        const ranked = computeDirectoryPage({ rooms, search: 'order=peer-rtt', rttMeasurements: measurements });

        expect(ordinary.entries.map((entry) => entry.groupRef.groupId)).toEqual([
            'crowded',
            'a-slow',
            'b-unknown',
            'z-fast'
        ]);
        expect(ordinary.entries.map((entry) => entry.peerRttMs)).toEqual([null, null, null, null]);
        expect(ranked.entries.map((entry) => entry.groupRef.groupId)).toEqual([
            'crowded',
            'z-fast',
            'a-slow',
            'b-unknown'
        ]);
        expect(ranked.entries.map((entry) => entry.peerRttMs)).toEqual([null, 20, 90, null]);
    });

    it('requires complete coverage of the current room sessions', () => {
        const partial = computeDirectoryPage({
            rooms: snapshots,
            search: 'order=peer-rtt',
            rttMeasurements: [createRttMeasurement('fast-1', 12)]
        });
        expect(partial.entries.map((entry) => entry.peerRttMs)).toEqual([null, null, null]);
        expect(partial.entries.map((entry) => entry.groupRef.groupId)).toEqual(['a-slow', 'b-unknown', 'z-fast']);
    });

    it.each([null, 'renewed-session'])('does not borrow another caller session evidence: %s', (sessionId) => {
        const result = computeDirectoryPage({
            rooms: snapshots,
            search: 'order=peer-rtt',
            rttMeasurements: measurements,
            requesterSessionId: sessionId
        });
        expect(result.entries.map((entry) => entry.peerRttMs)).toEqual([null, null, null]);
    });

    it.each([NOW - 60_000, NOW + 1])('treats an old or future sample as unknown: %s', (createdAtEpochMs) => {
        const result = computeDirectoryPage({
            rooms: [createRoomSnapshot('one', ['peer'])],
            search: 'order=peer-rtt',
            rttMeasurements: [{ ...createRttMeasurement('peer', 15), createdAtEpochMs }]
        });
        expect(result.entries[0]?.peerRttMs).toBeNull();
    });

    it('accepts a sample just inside the freshness window in either pair direction', () => {
        const result = computeDirectoryPage({
            rooms: [createRoomSnapshot('one', ['peer'])],
            search: 'order=peer-rtt',
            rttMeasurements: [{
                ...createRttMeasurement('peer', 15),
                sessionIdFrom: 'peer',
                sessionIdTo: 'requester-session',
                createdAtEpochMs: NOW - 59_999
            }]
        });
        expect(result.entries[0]?.peerRttMs).toBe(15);
    });

    it('does not treat missing or expired live presence as a measured empty room', () => {
        const snapshot = createRoomSnapshot('one', ['peer']);
        for (const activeSessions of [[], snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: NOW }))]) {
            const result = computeDirectoryPage({
                rooms: [{ ...snapshot, activeSessions }],
                search: 'order=peer-rtt',
                rttMeasurements: [createRttMeasurement('peer', 15)]
            });
            expect(result.entries[0]?.peerRttMs).toBeNull();
        }
    });

    it('includes every live session without turning extra sessions into extra occupancy', () => {
        const snapshot = createRoomSnapshot('one-member', ['peer-1', 'peer-2']);
        const result = computeDirectoryPage({
            rooms: [{
                ...snapshot,
                onlineMemberCount: 1,
                activeSessions: snapshot.activeSessions.map((session) => ({ ...session, principalId: 'principal-peer-1' }))
            }],
            search: 'order=peer-rtt',
            rttMeasurements: [createRttMeasurement('peer-1', 15), createRttMeasurement('peer-2', 65)]
        });
        expect(result.entries[0]?.peerRttMs).toBe(65);
        expect(result.entries[0]?.onlineMemberCount).toBe(1);
    });

    it('pages known and unknown scores in the selected order and rejects a mismatched cursor', () => {
        const first = computeDirectoryPage({ rooms: snapshots, search: 'order=peer-rtt&limit=1', rttMeasurements: measurements });
        const second = computeDirectoryPage({
            rooms: snapshots,
            search: `order=peer-rtt&limit=1&cursor=${first.nextCursor}`,
            rttMeasurements: measurements
        });
        const third = computeDirectoryPage({
            rooms: snapshots,
            search: `order=peer-rtt&limit=1&cursor=${second.nextCursor}`,
            rttMeasurements: measurements
        });
        expect([first, second, third].map((result) => result.entries[0]?.groupRef.groupId))
            .toEqual(['z-fast', 'a-slow', 'b-unknown']);
        expect(third.nextCursor).toBeNull();
        expect(decodeGroupDirectoryQuery(new URLSearchParams({ cursor: first.nextCursor! })).left)
            .toEqual(['cursor is not a cursor issued for this directory order']);
    });

    it('rejects an unsupported order instead of silently returning default order', () => {
        expect(decodeGroupDirectoryQuery(new URLSearchParams('order=nearest')).left)
            .toEqual(['order must be online-members or peer-rtt']);
    });
});

function computeDirectoryPage({ rooms, search, rttMeasurements, requesterSessionId = 'requester-session' }: DirectoryPageInput) {
    const decoded = decodeGroupDirectoryQuery(new URLSearchParams(search));
    if (!decoded.right) {
        throw new Error(`Invalid test directory query: ${decoded.left?.join('; ')}`);
    }
    const query = decoded.right;
    const input = { query, defaultMaxMembers: null, rttMeasurements, requesterSessionId, nowEpochMs: NOW };
    return computeGroupDirectoryPage(rooms, input);
}

function createRoomSnapshot(groupId: string, sessionIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupSnapshot(1, sessionIds);
    return {
        ...snapshot,
        group: { ...snapshot.group, groupId, displayName: groupId },
        members: snapshot.members.map((member) => ({ ...member, groupId })),
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, groupId }))
    };
}

function createRttMeasurement(peer: string, rttMs: number): RttMeasurementInfo {
    return {
        sessionIdFrom: 'requester-session',
        sessionIdTo: peer,
        rttMs,
        createdAtEpochMs: NOW - 1_000,
        version: 1
    };
}
