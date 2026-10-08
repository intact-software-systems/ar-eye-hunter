import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS,
    AL_VOLATILE_SESSION_LIMITS,
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_AGE_MS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    AL_VOLATILE_SESSION_MAX_TRACKS,
    AL_VOLATILE_SESSION_OWN_SHARE,
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

const NOW_MS = 1_700_000_000_000;

interface AdmissionOverrides {
    readonly bytes?: number;
    readonly deadlineAtMs?: number;
    readonly nowMs?: number;
    readonly trackKey?: string;
}

function toAdmission(
    msgId: string,
    overrides: AdmissionOverrides = {}
): ALVolatileSessionBudget.Admission {
    return {
        msgId,
        bytes: overrides.bytes ?? 100,
        deadlineAtMs: overrides.deadlineAtMs ?? NOW_MS + 30_000,
        nowMs: overrides.nowMs ?? NOW_MS,
        trackKey: overrides.trackKey
    };
}

function toLimits(overrides: Partial<ALVolatileSessionLimits>): ALVolatileSessionLimits {
    return { ...AL_VOLATILE_SESSION_LIMITS, ...overrides };
}

function createBudget(overrides: Partial<ALVolatileSessionLimits>): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget(toLimits(overrides));
}

function recordArrivals(budget: ALVolatileSessionBudget, count: number, bytes = 100): void {
    for (let index = 1; index <= count; index += 1) {
        budget.record(toAdmission(`received-${index}`, { bytes }));
    }
}

function admitOwnSends(budget: ALVolatileSessionBudget, count: number): readonly (number | undefined)[] {
    return Array.from({ length: count }, (_, index) => budget.tryAdmit(toAdmission(`sent-${index + 1}`)).right?.admissions);
}

describe('the per-session volatile budget (D74)', () => {
    it('holds D74\'s two limits and the inbound counted lifetime (R-S3c-ii-6)', () => {
        expect(AL_VOLATILE_SESSION_MAX_ADMISSIONS).toBe(1_000);
        expect(AL_VOLATILE_SESSION_MAX_BYTES).toBe(4 * 1024 * 1024);
        expect(AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS).toBe(30_000);
    });

    it('holds an age bound of five minutes and a track bound of 64 beside the count and byte bounds', () => {
        expect(AL_VOLATILE_SESSION_MAX_AGE_MS).toBe(5 * 60_000);
        expect(AL_VOLATILE_SESSION_MAX_TRACKS).toBe(64);
        expect(AL_VOLATILE_SESSION_LIMITS).toEqual({
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES,
            maxAgeMs: AL_VOLATILE_SESSION_MAX_AGE_MS,
            maxTracks: AL_VOLATILE_SESSION_MAX_TRACKS
        });
    });

    it('shares one frozen set of limits that no ledger reader can change', () => {
        const report = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS).readReport(NOW_MS);

        expect(Object.isFrozen(AL_VOLATILE_SESSION_LIMITS)).toBe(true);
        expect(() => {
            (report.limits as { maxTracks: number; }).maxTracks = 1_000;
        }).toThrow(TypeError);
        expect(AL_VOLATILE_SESSION_LIMITS.maxTracks).toBe(AL_VOLATILE_SESSION_MAX_TRACKS);
    });

    it('counts outbound and inbound admissions and their bytes together, and reports each pool beside the totals', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('sent', { bytes: 100 })).right).toEqual({
            admissions: 1,
            bytes: 100,
            oldestAgeMs: 0,
            tracks: 0
        });
        expect(budget.record(toAdmission('received', { bytes: 250 }))).toEqual({
            admissions: 2,
            bytes: 350,
            oldestAgeMs: 0,
            tracks: 0
        });
        expect(budget.readReport(NOW_MS).usage).toEqual({ admissions: 2, bytes: 350, oldestAgeMs: 0, tracks: 0 });
        expect(budget.readReport(NOW_MS)).toMatchObject({
            own: { admissions: 1, bytes: 100 },
            inbound: { admissions: 1, bytes: 250 }
        });
    });

    it('refuses the admission past the count limit, names that limit and counts nothing for it', () => {
        const budget = createBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('first'));
        budget.tryAdmit(toAdmission('second'));

        expect(budget.tryAdmit(toAdmission('third')).left).toEqual({
            limit: 'admissions',
            usage: { admissions: 2, bytes: 200, oldestAgeMs: 0, tracks: 0 },
            own: { admissions: 2, bytes: 200 },
            limits: toLimits({ maxAdmissions: 2, maxBytes: 1_000 })
        });
        expect(budget.readReport(NOW_MS).usage.admissions).toBe(2);
    });

    it('refuses an admission whose bytes would pass the byte limit and admits one that meets it', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 300 });

        expect(budget.tryAdmit(toAdmission('first', { bytes: 200 })).right?.bytes).toBe(200);
        expect(budget.tryAdmit(toAdmission('too-large', { bytes: 101 })).left?.limit).toBe('bytes');
        expect(budget.tryAdmit(toAdmission('fits', { bytes: 100 })).right?.bytes).toBe(300);
    });

    it('counts one ordered msgId once, with its bytes and its track, however many carriers admit it', () => {
        const budget = createBudget({ maxAdmissions: 1, maxBytes: 1_000 });
        const held = { admissions: 1, bytes: 100, oldestAgeMs: 0, tracks: 1 };

        expect(budget.tryAdmit(toAdmission('fallback', { trackKey: 'track-a' })).right).toEqual(held);
        // The WS leg of an rtc-with-ws-fallback send re-admits the RTC envelope while the bound is full.
        expect(budget.tryAdmit(toAdmission('fallback', { trackKey: 'track-a' })).right).toEqual(held);
        // A received copy of the same msgId names no track; it must neither double the bytes nor strand the track.
        expect(budget.record(toAdmission('fallback'))).toEqual(held);
        expect(budget.readReport(NOW_MS)).toMatchObject({
            own: { admissions: 1, bytes: 100 },
            inbound: { admissions: 0, bytes: 0 }
        });
        expect(budget.readReport(NOW_MS + 30_000).usage).toEqual({
            admissions: 0,
            bytes: 0,
            oldestAgeMs: 0,
            tracks: 0
        });
    });

    it('releases each admission at its own deadline, read without a timer', () => {
        const budget = createBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('short', { deadlineAtMs: NOW_MS + 1_000 }));
        budget.tryAdmit(toAdmission('long', { deadlineAtMs: NOW_MS + 5_000 }));

        expect(budget.tryAdmit(toAdmission('early', { nowMs: NOW_MS + 999 })).left?.limit).toBe(
            'admissions'
        );
        expect(budget.readReport(NOW_MS + 1_000).usage.admissions).toBe(1);
        expect(
            budget.tryAdmit(
                toAdmission('after-short', { nowMs: NOW_MS + 1_000, deadlineAtMs: NOW_MS + 9_000 })
            ).right?.admissions
        ).toBe(2);
        expect(budget.readReport(NOW_MS + 5_000).usage.admissions).toBe(1);
        expect(budget.readReport(NOW_MS + 9_000).usage).toEqual({
            admissions: 0,
            bytes: 0,
            oldestAgeMs: 0,
            tracks: 0
        });
    });

    it('releases admissions held out of deadline order, each at its own deadline, with their bytes', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 10_000 });
        budget.tryAdmit(toAdmission('third', { deadlineAtMs: NOW_MS + 3_000, bytes: 3 }));
        budget.tryAdmit(toAdmission('first', { deadlineAtMs: NOW_MS + 1_000, bytes: 1 }));
        budget.record(toAdmission('second', { deadlineAtMs: NOW_MS + 2_000, bytes: 2 }));

        expect(
            [0, 1_000, 2_000, 3_000].map((elapsedMs) => {
                const { admissions, bytes } = budget.readReport(NOW_MS + elapsedMs).usage;
                return { admissions, bytes };
            })
        ).toEqual([
            { admissions: 3, bytes: 6 },
            { admissions: 2, bytes: 5 },
            { admissions: 1, bytes: 3 },
            { admissions: 0, bytes: 0 }
        ]);
    });

    it('holds nothing for an admission whose deadline already passed', () => {
        const budget = createBudget({ maxAdmissions: 1, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('late', { deadlineAtMs: NOW_MS })).right?.admissions).toBe(0);
        expect(budget.tryAdmit(toAdmission('current')).right?.admissions).toBe(1);
    });

    it('never refuses a recorded inbound admission, which still counts toward the next outbound refusal (C6)', () => {
        const budget = createBudget({ maxAdmissions: 1, maxBytes: 1_000 });
        budget.record(toAdmission('received-1'));

        expect(budget.record(toAdmission('received-2')).admissions).toBe(2);
        expect(budget.tryAdmit(toAdmission('sent')).left?.limit).toBe('admissions');
    });

    it('counts an inbound admission for at most 30 s, whatever deadline its sender named (R-S3c-ii-6)', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 1_000 });
        budget.record(toAdmission('an-hour-ahead', { deadlineAtMs: NOW_MS + 3_600_000 }));

        expect(budget.readReport(NOW_MS + 29_999).usage.admissions).toBe(1);
        expect(budget.readReport(NOW_MS + 30_000).usage.admissions).toBe(0);
    });

    it('releases an inbound admission at its own deadline when that comes first', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 1_000 });
        budget.record(toAdmission('five-seconds', { deadlineAtMs: NOW_MS + 5_000 }));

        expect(budget.readReport(NOW_MS + 4_999).usage.admissions).toBe(1);
        expect(budget.readReport(NOW_MS + 5_000).usage.admissions).toBe(0);
    });

    it('keeps an outbound admission counted until its own deadline, up to the age bound', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('sent-for-five-minutes', { deadlineAtMs: NOW_MS + AL_VOLATILE_SESSION_MAX_AGE_MS }));

        expect(budget.readReport(NOW_MS + 30_000).usage.admissions).toBe(1);
        expect(budget.readReport(NOW_MS + AL_VOLATILE_SESSION_MAX_AGE_MS).usage.admissions).toBe(0);
    });

    it('refuses an outbound admission whose deadline lies past the age bound, names that limit and counts nothing for it', () => {
        const budget = createBudget({ maxAgeMs: 60_000 });

        expect(budget.tryAdmit(toAdmission('too-far', { deadlineAtMs: NOW_MS + 60_001 })).left).toEqual({
            limit: 'age',
            usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
            own: { admissions: 0, bytes: 0 },
            limits: toLimits({ maxAgeMs: 60_000 })
        });
        expect(budget.tryAdmit(toAdmission('at-the-bound', { deadlineAtMs: NOW_MS + 60_000 })).right?.admissions)
            .toBe(1);
    });

    it('refuses the ordered send that would open a track past the track bound and admits one on a counted track', () => {
        const budget = createBudget({ maxTracks: 2 });
        budget.tryAdmit(toAdmission('a-1', { trackKey: 'track-a' }));
        budget.tryAdmit(toAdmission('b-1', { trackKey: 'track-b' }));

        expect(budget.tryAdmit(toAdmission('c-1', { trackKey: 'track-c' })).left).toEqual({
            limit: 'tracks',
            usage: { admissions: 2, bytes: 200, oldestAgeMs: 0, tracks: 2 },
            own: { admissions: 2, bytes: 200 },
            limits: toLimits({ maxTracks: 2 })
        });
        expect(budget.tryAdmit(toAdmission('a-2', { trackKey: 'track-a' })).right?.tracks).toBe(2);
        expect(budget.tryAdmit(toAdmission('unordered')).right).toEqual({
            admissions: 4,
            bytes: 400,
            oldestAgeMs: 0,
            tracks: 2
        });
    });

    it('releases a track with its last counted admission, which lets the next track open', () => {
        const budget = createBudget({ maxTracks: 1 });
        budget.tryAdmit(toAdmission('a-1', { trackKey: 'track-a', deadlineAtMs: NOW_MS + 1_000 }));
        budget.tryAdmit(toAdmission('a-2', { trackKey: 'track-a', deadlineAtMs: NOW_MS + 2_000 }));

        expect(budget.readReport(NOW_MS + 1_000).usage.tracks).toBe(1);
        expect(budget.tryAdmit(toAdmission('b-1', { trackKey: 'track-b', nowMs: NOW_MS + 1_999 })).left?.limit)
            .toBe('tracks');
        expect(budget.readReport(NOW_MS + 2_000).usage.tracks).toBe(0);
        expect(budget.tryAdmit(toAdmission('b-2', { trackKey: 'track-b', nowMs: NOW_MS + 2_000 })).right?.tracks)
            .toBe(1);
    });

    it('never opens a counted track for a recorded inbound admission', () => {
        const budget = createBudget({ maxTracks: 1 });

        expect(budget.record(toAdmission('received', { trackKey: 'their-track' })).tracks).toBe(0);
        expect(budget.tryAdmit(toAdmission('sent', { trackKey: 'my-track' })).right?.tracks).toBe(1);
    });

    it('keeps a track counted while a later-admitted, earlier-due admission on it is released first', () => {
        const budget = createBudget({ maxTracks: 1 });
        budget.tryAdmit(toAdmission('a-late', { trackKey: 'track-a', deadlineAtMs: NOW_MS + 2_000 }));
        budget.tryAdmit(toAdmission('a-early', { trackKey: 'track-a', deadlineAtMs: NOW_MS + 1_000 }));

        expect(budget.readReport(NOW_MS + 1_000).usage).toEqual({
            admissions: 1,
            bytes: 100,
            oldestAgeMs: 1_000,
            tracks: 1
        });
        expect(budget.tryAdmit(toAdmission('b-1', { trackKey: 'track-b', nowMs: NOW_MS + 1_500 })).left?.limit)
            .toBe('tracks');
        expect(budget.tryAdmit(toAdmission('b-2', { trackKey: 'track-b', nowMs: NOW_MS + 2_000 })).right?.tracks)
            .toBe(1);
    });

    it('opens 64 tracks under the production limits and refuses the 65th', () => {
        const budget = createBudget({});
        for (let track = 1; track <= AL_VOLATILE_SESSION_MAX_TRACKS; track += 1) {
            expect(budget.tryAdmit(toAdmission(`sent-${track}`, { trackKey: `track-${track}` })).right?.tracks)
                .toBe(track);
        }

        expect(budget.tryAdmit(toAdmission('sent-65', { trackKey: 'track-65' })).left).toEqual({
            limit: 'tracks',
            usage: { admissions: 64, bytes: 6_400, oldestAgeMs: 0, tracks: 64 },
            own: { admissions: 64, bytes: 6_400 },
            limits: AL_VOLATILE_SESSION_LIMITS
        });
    });

    it('names the first bound a send passes in the order age, admissions, bytes, tracks', () => {
        const tight = { maxAgeMs: 60_000, maxAdmissions: 1, maxBytes: 150, maxTracks: 1 };
        const lifted = { maxAgeMs: AL_VOLATILE_SESSION_MAX_AGE_MS, maxAdmissions: 10, maxBytes: 1_000, maxTracks: 2 };
        const readVerdict = (limits: Partial<ALVolatileSessionLimits>) => {
            const budget = createBudget(limits);
            budget.tryAdmit(toAdmission('held', { trackKey: 'track-a' }));
            const passesAllFour = toAdmission('next', { trackKey: 'track-b', deadlineAtMs: NOW_MS + 60_001 });
            return budget.tryAdmit(passesAllFour).fold((refusal) => refusal.limit, () => 'admitted');
        };

        expect([
            readVerdict(tight),
            readVerdict({ ...tight, maxAgeMs: lifted.maxAgeMs }),
            readVerdict({ ...tight, maxAgeMs: lifted.maxAgeMs, maxAdmissions: lifted.maxAdmissions }),
            readVerdict({ ...lifted, maxTracks: tight.maxTracks }),
            readVerdict(lifted)
        ]).toEqual(['age', 'admissions', 'bytes', 'tracks', 'admitted']);
    });

    it('reads no negative age when the clock steps back behind the oldest admission', () => {
        const budget = createBudget({});
        budget.tryAdmit(toAdmission('sent'));

        expect(budget.readReport(NOW_MS - 1_000).usage).toEqual({
            admissions: 1,
            bytes: 100,
            oldestAgeMs: 0,
            tracks: 0
        });
    });

    it('reads the age of the oldest counted admission, and 0 when nothing is counted', () => {
        const budget = createBudget({});
        expect(budget.readReport(NOW_MS).usage.oldestAgeMs).toBe(0);
        budget.tryAdmit(toAdmission('first', { deadlineAtMs: NOW_MS + 2_000 }));
        budget.record(toAdmission('second', { nowMs: NOW_MS + 1_000, deadlineAtMs: NOW_MS + 9_000 }));

        expect(budget.readReport(NOW_MS + 1_500).usage.oldestAgeMs).toBe(1_500);
        expect(budget.readReport(NOW_MS + 2_500).usage.oldestAgeMs).toBe(1_500);
        expect(budget.readReport(NOW_MS + 9_000).usage.oldestAgeMs).toBe(0);
    });

    it('reports its usage, its limits and whether it is overloaded in one read', () => {
        const budget = createBudget({ maxAdmissions: 5, maxBytes: 1_000, maxTracks: 2 });
        budget.tryAdmit(toAdmission('a-1', { trackKey: 'track-a' }));

        expect(budget.readReport(NOW_MS + 250)).toEqual({
            usage: { admissions: 1, bytes: 100, oldestAgeMs: 250, tracks: 1 },
            own: { admissions: 1, bytes: 100 },
            inbound: { admissions: 0, bytes: 0 },
            limits: toLimits({ maxAdmissions: 5, maxBytes: 1_000, maxTracks: 2 }),
            overloaded: false
        });
    });

    it('is overloaded when its own sends hold the count or byte limit and clear below both (C13)', () => {
        const byCount = createBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        byCount.tryAdmit(toAdmission('first'));
        expect(byCount.readReport(NOW_MS).overloaded).toBe(false);
        byCount.tryAdmit(toAdmission('second'));
        expect(byCount.readReport(NOW_MS).overloaded).toBe(true);
        expect(byCount.readReport(NOW_MS + 30_000).overloaded).toBe(false);

        const byBytes = createBudget({ maxAdmissions: 10, maxBytes: 250 });
        byBytes.tryAdmit(toAdmission('large', { bytes: 250 }));
        expect(byBytes.readReport(NOW_MS).overloaded).toBe(true);
    });

    it('is not overloaded at the track bound, which refuses only a send that opens another track', () => {
        const budget = createBudget({ maxTracks: 1 });
        budget.tryAdmit(toAdmission('a-1', { trackKey: 'track-a' }));

        expect(budget.readReport(NOW_MS).usage.tracks).toBe(1);
        expect(budget.readReport(NOW_MS).overloaded).toBe(false);
    });
});

describe('the own share of the per-session volatile budget (D189)', () => {
    it('keeps half of the count and byte limits for the session\'s own sends', () => {
        expect(AL_VOLATILE_SESSION_OWN_SHARE).toBe(0.5);
    });

    it('admits own sends up to the own share while arrivals hold the total at the count limit, then refuses the next', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 100_000 });
        recordArrivals(budget, 10);

        expect(admitOwnSends(budget, 5)).toEqual([11, 12, 13, 14, 15]);
        expect(budget.tryAdmit(toAdmission('sent-6')).left).toEqual({
            limit: 'admissions',
            usage: { admissions: 15, bytes: 1_500, oldestAgeMs: 0, tracks: 0 },
            own: { admissions: 5, bytes: 500 },
            limits: toLimits({ maxAdmissions: 10, maxBytes: 100_000 })
        });
        expect(budget.readReport(NOW_MS)).toMatchObject({
            own: { admissions: 5, bytes: 500 },
            inbound: { admissions: 10, bytes: 1_000 },
            overloaded: true
        });
    });

    it('lets own sends past the share use the admissions arrivals leave free', () => {
        const budget = createBudget({ maxAdmissions: 10, maxBytes: 100_000 });
        recordArrivals(budget, 2);

        expect(admitOwnSends(budget, 8)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
        expect(budget.tryAdmit(toAdmission('sent-9')).left?.limit).toBe('admissions');
    });

    it('admits own bytes up to the own share while arrivals hold the total at the byte limit, then refuses the next', () => {
        const budget = createBudget({ maxAdmissions: 100, maxBytes: 1_000 });
        budget.record(toAdmission('received', { bytes: 1_000 }));

        expect(budget.tryAdmit(toAdmission('sent', { bytes: 300 })).right?.bytes).toBe(1_300);
        expect(budget.tryAdmit(toAdmission('past-the-share', { bytes: 201 })).left?.limit).toBe('bytes');
        expect(budget.tryAdmit(toAdmission('fills-the-share', { bytes: 200 })).right?.bytes).toBe(1_500);
        expect(budget.tryAdmit(toAdmission('one-byte-more', { bytes: 1 })).left?.limit).toBe('bytes');
    });

    it('lets own bytes past the share use the bytes arrivals leave free', () => {
        const budget = createBudget({ maxAdmissions: 100, maxBytes: 1_000 });
        budget.record(toAdmission('received', { bytes: 200 }));

        expect(budget.tryAdmit(toAdmission('sent', { bytes: 700 })).right?.bytes).toBe(900);
        expect(budget.tryAdmit(toAdmission('past-the-limit', { bytes: 101 })).left?.limit).toBe('bytes');
        expect(budget.tryAdmit(toAdmission('fills-the-limit', { bytes: 100 })).right?.bytes).toBe(1_000);
    });

    it('rounds the own share down, so a bound of one admission keeps none and a bound of three keeps one', () => {
        const ofOne = createBudget({ maxAdmissions: 1, maxBytes: 100_000 });
        recordArrivals(ofOne, 1);
        const ofThree = createBudget({ maxAdmissions: 3, maxBytes: 100_000 });
        recordArrivals(ofThree, 3);

        expect(ofOne.tryAdmit(toAdmission('sent-1')).left?.limit).toBe('admissions');
        expect(admitOwnSends(ofThree, 2)).toEqual([4, undefined]);
    });

    it('frees its own share as its own admissions reach their deadlines, while arrivals still hold the total', () => {
        const budget = createBudget({ maxAdmissions: 4, maxBytes: 100_000 });
        recordArrivals(budget, 4);
        budget.tryAdmit(toAdmission('sent-early', { deadlineAtMs: NOW_MS + 1_000 }));
        budget.tryAdmit(toAdmission('sent-late', { deadlineAtMs: NOW_MS + 5_000 }));

        expect(budget.tryAdmit(toAdmission('refused', { nowMs: NOW_MS + 999 })).left?.limit).toBe('admissions');
        expect(budget.readReport(NOW_MS + 1_000)).toMatchObject({
            own: { admissions: 1, bytes: 100 },
            inbound: { admissions: 4, bytes: 400 },
            overloaded: false
        });
        expect(budget.tryAdmit(toAdmission('admitted', { nowMs: NOW_MS + 1_000 })).right?.admissions).toBe(6);
    });

    it.each(
        [
            [0, 0, false],
            [3, 0, false],
            [4, 0, false],
            [4, 1, false],
            [4, 2, true],
            [2, 2, true],
            [1, 3, true],
            [0, 4, true]
        ] as const
    )(
        'with %i arrivals and %i own sends under four admissions, reads overloaded %s exactly as it refuses the next own send',
        (arrivals, own, overloaded) => {
            const budget = createBudget({ maxAdmissions: 4, maxBytes: 100_000 });
            recordArrivals(budget, arrivals);
            admitOwnSends(budget, own);

            expect(budget.readReport(NOW_MS).overloaded).toBe(overloaded);
            expect(budget.tryAdmit(toAdmission('next', { bytes: 1 })).left?.limit).toBe(overloaded ? 'admissions' : undefined);
        }
    );

    it.each(
        [
            [1_000, 0, false],
            [1_000, 499, false],
            [1_000, 500, true],
            [400, 600, true],
            [300, 600, false]
        ] as const
    )(
        'with %i arrival and %i own bytes under 1 000, reads overloaded %s exactly as it refuses a one-byte own send',
        (arrivalBytes, ownBytes, overloaded) => {
            const budget = createBudget({ maxAdmissions: 100, maxBytes: 1_000 });
            budget.record(toAdmission('received', { bytes: arrivalBytes }));
            budget.tryAdmit(toAdmission('sent', { bytes: ownBytes }));

            expect(budget.readReport(NOW_MS).overloaded).toBe(overloaded);
            expect(budget.tryAdmit(toAdmission('next', { bytes: 1 })).left?.limit).toBe(overloaded ? 'bytes' : undefined);
        }
    );
});
