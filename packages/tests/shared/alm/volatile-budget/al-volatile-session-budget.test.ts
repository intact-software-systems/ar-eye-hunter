import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

const NOW_MS = 1_700_000_000_000;

interface AdmissionOverrides {
    readonly bytes?: number;
    readonly deadlineAtMs?: number;
    readonly nowMs?: number;
}

function toAdmission(
    msgId: string,
    overrides: AdmissionOverrides = {}
): ALVolatileSessionBudget.Admission {
    return {
        msgId,
        bytes: overrides.bytes ?? 100,
        deadlineAtMs: overrides.deadlineAtMs ?? NOW_MS + 30_000,
        nowMs: overrides.nowMs ?? NOW_MS
    };
}

describe('the per-session volatile budget (D74)', () => {
    it('holds D74\'s two limits', () => {
        expect(AL_VOLATILE_SESSION_MAX_ADMISSIONS).toBe(1_000);
        expect(AL_VOLATILE_SESSION_MAX_BYTES).toBe(4 * 1024 * 1024);
    });

    it('counts outbound and inbound admissions and their bytes together', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('sent', { bytes: 100 })).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        expect(budget.record(toAdmission('received', { bytes: 250 }))).toEqual({
            admissions: 2,
            bytes: 350
        });
        expect(budget.readUsage(NOW_MS)).toEqual({ admissions: 2, bytes: 350 });
    });

    it('refuses the admission past the count limit, names that limit and counts nothing for it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('first'));
        budget.tryAdmit(toAdmission('second'));

        expect(budget.tryAdmit(toAdmission('third')).left).toEqual({
            limit: 'admissions',
            usage: { admissions: 2, bytes: 200 },
            limits: { maxAdmissions: 2, maxBytes: 1_000 }
        });
        expect(budget.readUsage(NOW_MS)).toEqual({ admissions: 2, bytes: 200 });
    });

    it('refuses an admission whose bytes would pass the byte limit and admits one that meets it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 300 });

        expect(budget.tryAdmit(toAdmission('first', { bytes: 200 })).right).toEqual({
            admissions: 1,
            bytes: 200
        });
        expect(budget.tryAdmit(toAdmission('too-large', { bytes: 101 })).left?.limit).toBe('bytes');
        expect(budget.tryAdmit(toAdmission('fits', { bytes: 100 })).right).toEqual({
            admissions: 2,
            bytes: 300
        });
    });

    it('counts one msgId once, however many carriers admit it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('fallback')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        // The WS leg of an rtc-with-ws-fallback send re-admits the RTC envelope while the bound is full.
        expect(budget.tryAdmit(toAdmission('fallback')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        expect(budget.record(toAdmission('fallback'))).toEqual({ admissions: 1, bytes: 100 });
    });

    it('releases each admission at its own deadline, read without a timer', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('short', { deadlineAtMs: NOW_MS + 1_000 }));
        budget.tryAdmit(toAdmission('long', { deadlineAtMs: NOW_MS + 5_000 }));

        expect(budget.tryAdmit(toAdmission('early', { nowMs: NOW_MS + 999 })).left?.limit).toBe(
            'admissions'
        );
        expect(budget.readUsage(NOW_MS + 1_000)).toEqual({ admissions: 1, bytes: 100 });
        expect(
            budget.tryAdmit(
                toAdmission('after-short', { nowMs: NOW_MS + 1_000, deadlineAtMs: NOW_MS + 9_000 })
            ).right
        ).toEqual({ admissions: 2, bytes: 200 });
        expect(budget.readUsage(NOW_MS + 5_000)).toEqual({ admissions: 1, bytes: 100 });
        expect(budget.readUsage(NOW_MS + 9_000)).toEqual({ admissions: 0, bytes: 0 });
    });

    it('holds nothing for an admission whose deadline already passed', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('late', { deadlineAtMs: NOW_MS })).right).toEqual({
            admissions: 0,
            bytes: 0
        });
        expect(budget.tryAdmit(toAdmission('current')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
    });

    it('never refuses a recorded inbound admission, which still counts toward the next outbound refusal (C6)', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });
        budget.record(toAdmission('received-1'));

        expect(budget.record(toAdmission('received-2'))).toEqual({ admissions: 2, bytes: 200 });
        expect(budget.tryAdmit(toAdmission('sent')).left?.limit).toBe('admissions');
    });

    it('is overloaded at or over either limit and clear below both (C13)', () => {
        const byCount = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        byCount.record(toAdmission('first'));
        expect(byCount.isOverloaded(NOW_MS)).toBe(false);
        byCount.record(toAdmission('second'));
        expect(byCount.isOverloaded(NOW_MS)).toBe(true);
        expect(byCount.isOverloaded(NOW_MS + 30_000)).toBe(false);

        const byBytes = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 250 });
        byBytes.record(toAdmission('large', { bytes: 250 }));
        expect(byBytes.isOverloaded(NOW_MS)).toBe(true);
    });
});
