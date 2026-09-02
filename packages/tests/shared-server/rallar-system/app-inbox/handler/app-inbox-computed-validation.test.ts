import { Temporal } from '@js-temporal/polyfill';
import {
    validateAppInboxComputedData,
    validateAppInboxComputedProjection
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-computed-validation.ts';
import { describe, expect, it, vi } from 'vitest';

describe('AppInbox computed data validation', () => {
    it('accepts data properties without recomputing their domain meaning', () => {
        const shared = { revision: 1 };
        const candidate = {
            rows: [shared, shared],
            date: new Date(1_000),
            instant: Temporal.Instant.fromEpochMilliseconds(1_000),
            timestamp: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            time: Temporal.PlainTime.from('12:00:00'),
            error: new TypeError('Rejected'),
            bytes: new Uint8Array([1, 2, 3]),
            missing: undefined,
            absent: null
        };

        expect(validateAppInboxComputedData(candidate, 'computed')).toEqual([]);
    });

    it('rejects accessor properties, including hidden ones, without invoking them', () => {
        let calls = 0;
        const candidate = {
            row: Object.defineProperty({}, 'createdAt', {
                get: () => {
                    calls += 1;
                    throw new RangeError('Must not execute');
                }
            })
        };

        expect(validateAppInboxComputedData(candidate, 'computed').map((issue) => issue.path))
            .toEqual(['computed.row.createdAt']);
        expect(calls).toBe(0);
    });

    it('rejects proxies before invoking traps, including proxies in the prototype position', () => {
        let calls = 0;
        const proxy = new Proxy({}, {
            get: () => {
                calls += 1;
                throw new Error('get');
            },
            getPrototypeOf: () => {
                calls += 1;
                throw new Error('getPrototypeOf');
            },
            ownKeys: () => {
                calls += 1;
                throw new Error('ownKeys');
            },
            getOwnPropertyDescriptor: () => {
                calls += 1;
                throw new Error('getOwnPropertyDescriptor');
            }
        });

        expect(validateAppInboxComputedData(proxy, 'computed').map((issue) => issue.path)).toEqual(['computed']);
        expect(validateAppInboxComputedData({ row: proxy }, 'computed').map((issue) => issue.path))
            .toEqual(['computed.row']);
        expect(validateAppInboxComputedData(Object.create(proxy), 'computed').map((issue) => issue.path))
            .toEqual(['computed']);
        expect(calls).toBe(0);
    });

    it('rejects callbacks and cycles as data instead of invoking or recursing through them', () => {
        let calls = 0;
        const candidate = {
            toJSON: () => {
                calls += 1;
                return {};
            }
        };
        Object.defineProperty(candidate, 'self', { value: candidate });

        expect(validateAppInboxComputedData(candidate, 'computed').map((issue) => issue.path))
            .toEqual(['computed.toJSON', 'computed.self']);
        expect(calls).toBe(0);
    });

    it.each([Object.create(Array.prototype), Object.prototype, null])(
        'rejects arrays with a replaced prototype before consumers can invoke inherited behavior',
        (prototype) => {
            const candidate = Object.setPrototypeOf(['outbox-id'], prototype);

            expect(validateAppInboxComputedData(candidate, 'computed').map((issue) => issue.path)).toEqual(['computed']);
        }
    );

    it('does not inspect the ignored native error stack', () => {
        let calls = 0;
        const candidate = Object.defineProperty(new TypeError('Rejected'), 'stack', {
            get: () => {
                calls += 1;
                throw new Error('Must not format a stack');
            }
        });

        expect(validateAppInboxComputedData(candidate, 'computed')).toEqual([]);
        expect(calls).toBe(0);
    });

    it.each([new Map(), Object.create(Array.prototype), Object.create(Date.prototype)])(
        'rejects opaque or counterfeit data containers',
        (candidate) => {
            expect(validateAppInboxComputedData(candidate, 'computed').map((issue) => issue.path)).toEqual(['computed']);
        }
    );

    it('rejects a record imitating an array prototype and element descriptors', () => {
        const expected = { members: ['alice'] };
        const candidate = {
            members: Object.create(Array.prototype, {
                0: { value: 'alice', enumerable: true, configurable: true, writable: true },
                length: { value: 1, enumerable: false, configurable: false, writable: true }
            })
        };

        expect(validateAppInboxComputedProjection(expected, candidate, 'computed').map((issue) => issue.path))
            .toEqual(['computed.members']);
    });

    it('fails closed for opaque container values instead of comparing empty property lists', () => {
        const expected = { members: new Map([['alice', 'owner']]) };
        const candidate = { members: new Map([['mallory', 'owner']]) };

        expect(validateAppInboxComputedProjection(expected, candidate, 'computed').map((issue) => issue.path))
            .toEqual(['computed.members']);
    });

    it('compares binary persistence data by its bytes', () => {
        const expected = { bytes: new Uint8Array([1, 2, 3]) };

        expect(validateAppInboxComputedProjection(expected, { bytes: new Uint8Array([1, 2, 3]) }, 'computed')).toEqual([]);
        expect(validateAppInboxComputedProjection(expected, { bytes: new Uint8Array([1, 9, 3]) }, 'computed').map((issue) => issue.path))
            .toEqual(['computed.bytes.1']);
    });

    it('inspects a repeated computed object pair only once', () => {
        const expectedRow = { revision: 1 };
        const candidateRow = { revision: 1 };
        const expected = { row: expectedRow, repeatedRow: expectedRow };
        const candidate = { row: candidateRow, repeatedRow: candidateRow };
        const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
        let candidateRowInspections = 0;
        const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation((value) => {
            if (value === candidateRow) {
                candidateRowInspections += 1;
            }
            return getOwnPropertyDescriptors(value);
        });

        try {
            expect(validateAppInboxComputedProjection(expected, candidate, 'computed')).toEqual([]);
            expect(candidateRowInspections).toBe(1);
        }
        finally {
            descriptors.mockRestore();
        }
    });
});
