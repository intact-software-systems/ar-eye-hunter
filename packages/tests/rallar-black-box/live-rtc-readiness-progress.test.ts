import { describe, expect, it } from 'vitest';

import type { FormationDiagnosticEvent } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';
import { validateProgressSeries } from '../../../tests/playwright/rallar-black-box/live-rtc-readiness-progress.ts';

describe('readiness observation window', () => {
    it('accepts hydration followed by partial and complete readiness without a group write', () => {
        const hydration = sample(8, 0);
        hydration.data.room = { desiredPeerIds: [], readyPeerIds: [] };
        expect(validateProgressSeries([hydration, sample(8, 0), sample(8, 1), sample(8, 2)])).toEqual([]);
    });

    it('rejects a window that mixes group revisions even when readiness only rises', () => {
        expect(validateProgressSeries([sample(8, 0), sample(9, 2)])).toContainEqual({
            index: 1,
            reason: 'the group revision moved inside the window'
        });
    });

    it('rejects changing accepted layouts, falling readiness and incomplete final readiness', () => {
        const observations = [sample(8, 2), sample(8, 1)];
        observations[1].data.room = {
            desiredPeerIds: ['A', 'B'],
            readyPeerIds: ['A'],
            acceptedLayoutIdentity: { groupRevision: 7, presenceRevision: 5, version: 4, state: 'active' }
        };
        expect(validateProgressSeries(observations).map(({ reason }) => reason)).toEqual([
            'the accepted layout changed inside the window',
            'the ready fraction fell to 0.5',
            'the window ended at 0.5'
        ]);
    });
});

describe('reopening readiness across group writes', () => {
    it('validates every window and allows a write to interrupt an incomplete window', () => {
        expect(validateProgressSeries([
            sample(8, 0),
            sample(8, 1),
            sample(9, 1),
            sample(9, 2)
        ], 'successive-revisions')).toEqual([]);
    });

    it('retains a falling fraction in an earlier window even when the final window succeeds', () => {
        expect(validateProgressSeries([
            sample(8, 1),
            sample(8, 0),
            sample(9, 2)
        ], 'successive-revisions')).toEqual([{ index: 1, reason: 'the ready fraction fell to 0' }]);
    });

    it('rejects backwards revisions and requires the final window to complete', () => {
        expect(validateProgressSeries([sample(9, 0), sample(8, 1)], 'successive-revisions')).toEqual([
            { index: 1, reason: 'the group revision moved backwards' },
            { index: 1, reason: 'the window ended at 0.5' }
        ]);
    });

    it('rejects malformed evidence rather than treating it as hydration', () => {
        const malformed = sample(8, 2);
        delete malformed.data.room;
        expect(validateProgressSeries([sample(8, 0), malformed, sample(8, 2)], 'successive-revisions')).toContainEqual({
            index: 1,
            reason: 'the sample has no valid room'
        });
        malformed.data.room = { desiredPeerIds: ['A', 'B'], readyPeerIds: ['A', 'B'] };
        expect(validateProgressSeries([malformed], 'successive-revisions')).toContainEqual({
            index: 0,
            reason: 'desired peers require an active accepted layout identity'
        });
    });

    it('compares layout identity by its fields rather than JSON property order', () => {
        const reordered = sample(8, 2);
        reordered.data.room = {
            desiredPeerIds: ['A', 'B'],
            readyPeerIds: ['A', 'B'],
            acceptedLayoutIdentity: { state: 'active', version: 3, presenceRevision: 5, groupRevision: 7 }
        };
        expect(validateProgressSeries([sample(8, 0), reordered], 'successive-revisions')).toEqual([]);
    });

    it.each([8, 9])('rejects losing the denominator after hydration at revision %s', (revision) => {
        const empty = sample(revision, 0);
        empty.data.room = { desiredPeerIds: [], readyPeerIds: [] };
        expect(validateProgressSeries([sample(8, 2), empty, sample(10, 2)], 'successive-revisions')).toContainEqual({
            index: 1,
            reason: 'the desired peer set disappeared after hydration'
        });
    });

    it.each([['A', 'A'], ['X', 'Y']])('rejects invalid ready peer sets %j', (...ready) => {
        const invalid = sample(8, 2);
        invalid.data.room = {
            desiredPeerIds: ['A', 'B'],
            readyPeerIds: ready,
            acceptedLayoutIdentity: { groupRevision: 7, presenceRevision: 5, version: 3, state: 'active' }
        };
        expect(validateProgressSeries([invalid], 'successive-revisions')).toContainEqual({
            index: 0,
            reason: 'ready peers must be a unique subset of desired peers'
        });
    });

    it('does not accept missing readiness evidence', () => {
        expect(validateProgressSeries([], 'successive-revisions')).toEqual([
            { index: -1, reason: 'no sample carried a desired peer set' }
        ]);
    });
});

function sample(groupRevision: number, readyCount: number): FormationDiagnosticEvent {
    return {
        topic: 'rallar.browser.formation.room-status',
        atEpochMs: 100,
        data: {
            groupRevision,
            room: {
                desiredPeerIds: ['A', 'B'],
                readyPeerIds: ['A', 'B'].slice(0, readyCount),
                acceptedLayoutIdentity: { groupRevision: 7, presenceRevision: 5, version: 3, state: 'active' }
            }
        }
    };
}
