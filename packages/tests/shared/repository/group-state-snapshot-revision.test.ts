import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import {
    decideGroupSnapshotCausalRevision,
    isGroupSnapshotCausalRevisionCovered
} from '@shared/repository/group-state-snapshot-revision.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import { createGroupSnapshot } from '../../shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';

function withCausalRevision(snapshot: GroupSnapshot, causalRevision: GroupStateCausalRevision): GroupSnapshot {
    return { ...snapshot, causalRevision };
}

function withReversedKeys(snapshot: GroupSnapshot): GroupSnapshot {
    return JSON.parse(
        JSON.stringify(snapshot),
        (_key, value) =>
            value !== null && typeof value === 'object' && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).reverse())
                : value
    ) as GroupSnapshot;
}

function withRenamedGroup(snapshot: GroupSnapshot): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, displayName: `${snapshot.group.displayName} renamed` } };
}

function withRenewedLeases(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs + 1,
            expiresAtEpochMs: session.expiresAtEpochMs + 1
        }))
    };
}

describe('group snapshot causal revision decisions', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('advances a newer revision and keeps an incomparable tuple incomparable', () => {
        const current = createGroupSnapshot(3, ['session-a']);

        expect(decideGroupSnapshotCausalRevision(current, createGroupSnapshot(4, ['session-a']))).toBe('advanced');
        expect(decideGroupSnapshotCausalRevision(current, createGroupSnapshot(2, ['session-a']))).toBe('stale');
        expect(decideGroupSnapshotCausalRevision(
            current,
            withCausalRevision(current, { groupRevision: 4, presenceRevision: 0 })
        )).toBe('incomparable');
    });

    it('decides an equal revision with reordered content as a duplicate without serializing either side', () => {
        const current = createGroupSnapshot(3, ['session-a', 'session-b']);
        const reordered = withReversedKeys(current);
        const stringify = vi.spyOn(JSON, 'stringify');
        const localeCompare = vi.spyOn(String.prototype, 'localeCompare');

        expect(decideGroupSnapshotCausalRevision(current, reordered)).toBe('duplicate');
        expect(isGroupSnapshotCausalRevisionCovered(current, reordered)).toBe(true);
        expect(stringify.mock.calls.length + localeCompare.mock.calls.length).toBe(0);
    });

    it('still detects an equal revision with different content', () => {
        const current = createGroupSnapshot(3, ['session-a']);

        expect(() => decideGroupSnapshotCausalRevision(current, withRenamedGroup(current)))
            .toThrow(StateSnapshotRevisionConflictError);
    });
});

describe('held group snapshot causal revisions', () => {
    const held = createGroupSnapshot(3, ['session-a']);

    it.each(
        [
            ['nothing held', undefined, held, false],
            ['the same revision held', held, withReversedKeys(held), true],
            ['the same revision held with renewed leases', held, withRenewedLeases(held), true],
            ['the same revision held with different content', held, withRenamedGroup(held), false],
            ['a newer revision held', held, createGroupSnapshot(2, ['session-a']), true],
            ['an older revision held', held, createGroupSnapshot(4, ['session-a']), false],
            ['an incomparable revision held', held, withCausalRevision(held, { groupRevision: 4, presenceRevision: 0 }), false]
        ] as const
    )('decides %s', (_case, current, incoming, expected) => {
        expect(isGroupSnapshotCausalRevisionCovered(current, incoming)).toBe(expected);
    });

    it('covers the held snapshot itself without walking its content', () => {
        const readKeys = new Set<PropertyKey>();
        const same = new Proxy(createGroupSnapshot(3, ['session-a']), {
            get: (target, key, receiver) => {
                readKeys.add(key);
                return Reflect.get(target, key, receiver);
            }
        });

        expect(isGroupSnapshotCausalRevisionCovered(same, same)).toBe(true);
        expect(decideGroupSnapshotCausalRevision(same, same)).toBe('duplicate');
        expect([...readKeys]).toEqual(['causalRevision']);
    });
});
