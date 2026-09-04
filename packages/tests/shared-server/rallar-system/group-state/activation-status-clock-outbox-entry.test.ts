import { describe, expect, it } from 'vitest';

import {
    computeActivationStatusClockEntry,
    type GroupActivationStatusClockWork
} from '@shared-server/rallar-system/group-state/activation-status-clock-outbox-entry.ts';

const BASIS = { groupRevision: 7, presenceRevision: 3, version: 2, state: 'active' } as const;

describe('the activation status clock entry', () => {
    // The key does the cluster work: N nodes observing one dip write one row.
    it('gives one key to every node arming the same dwell', () => {
        expect(keyOf(clock({}))).toEqual(keyOf(clock({ dueAtEpochMs: 9_999 })));
    });

    // A dwell measures how long a band has held continuously, so a re-arm must
    // leave the original due instant standing rather than push it out.
    it('carries the armed due instant as the entry visibility', () => {
        expect(
            computeActivationStatusClockEntry(input(clock({ dueAtEpochMs: 5_000 })))
                .dequeueAudit.nextTs?.epochMilliseconds
        ).toBe(5_000);
    });

    it('separates the dwell and the expiry heartbeat', () => {
        expect(keyOf(clock({}))).not.toEqual(
            keyOf(clock({ kind: 'evidence-expiry', candidateCondition: null }))
        );
    });

    it('separates two bands and two series', () => {
        expect(keyOf(clock({}))).not.toEqual(keyOf(clock({ candidateCondition: 'failed' })));
        expect(keyOf(clock({}))).not.toEqual(keyOf(clock({ formationEpoch: 9 })));
        expect(keyOf(clock({}))).not.toEqual(
            keyOf(clock({ coverageBasisLayoutIdentity: { ...BASIS, version: 3 } }))
        );
    });
});

function clock(overrides: Partial<GroupActivationStatusClockWork>): GroupActivationStatusClockWork {
    return {
        kind: 'dwell',
        groupRef: { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' },
        formationEpoch: 2,
        coverageBasisLayoutIdentity: BASIS,
        candidateCondition: 'degraded',
        dueAtEpochMs: 5_000,
        ...overrides
    };
}

function input(work: GroupActivationStatusClockWork) {
    return { work, senderId: 'server-1', createdAtEpochMs: 1_000, expireAtEpochMs: 600_000 };
}

function keyOf(work: GroupActivationStatusClockWork) {
    return computeActivationStatusClockEntry(input(work)).key;
}
