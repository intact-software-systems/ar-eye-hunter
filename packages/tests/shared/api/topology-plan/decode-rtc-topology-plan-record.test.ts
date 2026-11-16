import { describe, expect, it } from 'vitest';

import { decodeRtcTopologyPlanRecord } from '@shared/api/topology-plan/decode-rtc-topology-plan-record.ts';
import type { RtcTopologyPlanRecord } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';
import { TOPOLOGY_RESHAPE_REASONS } from '@shared/api/topology-plan/topology-plan-change.ts';
import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from './empty-topology-layout-delta.ts';

const FIRST_LAYOUT_RECORD: RtcTopologyPlanRecord = {
    plannedAtEpochMs: 1_700_000_000_000,
    replaced: null,
    causes: ['join'],
    delta: {
        joinedSessionCount: 3,
        leftSessionCount: 0,
        changedSessionCount: 0,
        reroutedSessionCount: 0,
        acceptingSessionCount: 3,
        maxJoinerEdgesPerSession: 2
    },
    longestPathHops: 2,
    change: { kind: 'attach' }
};

const REPLACING_RECORD: RtcTopologyPlanRecord = {
    ...FIRST_LAYOUT_RECORD,
    replaced: {
        layout: { groupRevision: 4, presenceRevision: 9, version: 2, state: 'active' },
        ageMs: 12_500
    },
    causes: ['join', 'leave', 'rtt'],
    change: { kind: 'reshape', reason: 'refinement' }
};

describe('decodeRtcTopologyPlanRecord', () => {
    it('decodes a first layout\'s record, whose replaced layout is null', () => {
        const decoded = decodeRtcTopologyPlanRecord(structuredClone(FIRST_LAYOUT_RECORD));

        expect(decoded.right).toEqual(FIRST_LAYOUT_RECORD);
    });

    it('decodes a record that names the replaced layout, its age and its causes', () => {
        const decoded = decodeRtcTopologyPlanRecord(structuredClone(REPLACING_RECORD));

        expect(decoded.right).toEqual(REPLACING_RECORD);
    });

    it('refuses an unknown cause, a repeated cause and causes out of canonical order', () => {
        for (const causes of [['join', 'storm'], ['join', 'join'], ['leave', 'join']]) {
            expect(decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, causes }).left).toBeTypeOf('string');
        }
    });

    it('refuses a missing or extra key at any level', () => {
        const { longestPathHops: _omitted, ...withoutHops } = REPLACING_RECORD;
        const { joinedSessionCount: _joined, ...deltaWithoutJoined } = REPLACING_RECORD.delta;
        const variants = [
            withoutHops,
            { ...REPLACING_RECORD, extra: 1 },
            { ...REPLACING_RECORD, delta: deltaWithoutJoined },
            { ...REPLACING_RECORD, delta: { ...REPLACING_RECORD.delta, extra: 1 } },
            { ...REPLACING_RECORD, replaced: { layout: REPLACING_RECORD.replaced?.layout } },
            { ...REPLACING_RECORD, replaced: { ...REPLACING_RECORD.replaced, extra: 1 } },
            { ...REPLACING_RECORD, replaced: { ...REPLACING_RECORD.replaced, layout: { groupRevision: 1 } } }
        ];

        for (const variant of variants) {
            expect(decodeRtcTopologyPlanRecord(variant).left).toBeTypeOf('string');
        }
    });

    it('refuses a negative or fractional count', () => {
        const variants = [
            { ...REPLACING_RECORD, plannedAtEpochMs: -1 },
            { ...REPLACING_RECORD, longestPathHops: 1.5 },
            { ...REPLACING_RECORD, delta: { ...REPLACING_RECORD.delta, leftSessionCount: -1 } },
            { ...REPLACING_RECORD, delta: { ...REPLACING_RECORD.delta, maxJoinerEdgesPerSession: 0.5 } },
            { ...REPLACING_RECORD, replaced: { ...REPLACING_RECORD.replaced, ageMs: -5 } }
        ];

        for (const variant of variants) {
            expect(decodeRtcTopologyPlanRecord(variant).left).toBeTypeOf('string');
        }
    });

    it('decodes every kind of change, and a null change for a plan that changes nothing', () => {
        const records: RtcTopologyPlanRecord[] = [
            { ...REPLACING_RECORD, change: { kind: 'repair' } },
            ...TOPOLOGY_RESHAPE_REASONS.map((reason) => ({ ...REPLACING_RECORD, change: { kind: 'reshape', reason } } as const)),
            { ...REPLACING_RECORD, delta: EMPTY_TOPOLOGY_LAYOUT_DELTA, change: null }
        ];

        for (const record of records) {
            expect(decodeRtcTopologyPlanRecord(structuredClone(record)).right).toEqual(record);
        }
    });

    it('refuses a change that is null while the delta is not empty, or set while the delta is empty', () => {
        expect(decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, change: null }).left).toBeTypeOf('string');
        expect(decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, delta: EMPTY_TOPOLOGY_LAYOUT_DELTA }).left).toBeTypeOf('string');
    });

    it('refuses an unknown kind, an unknown or missing reshape reason, and a reason on another kind', () => {
        const changes = [
            { kind: 'rebuild' },
            { kind: 'reshape', reason: 'storm' },
            { kind: 'reshape' },
            { kind: 'attach', reason: 'refinement' },
            { kind: 'repair', extra: 1 },
            'attach',
            undefined
        ];

        for (const change of changes) {
            expect(decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, change }).left).toBeTypeOf('string');
        }
        const { change: _omitted, ...withoutChange } = REPLACING_RECORD;
        expect(decodeRtcTopologyPlanRecord(withoutChange).left).toBeTypeOf('string');
    });

    it('accepts a record with no cause', () => {
        const decoded = decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, causes: [] });

        expect(decoded.right?.causes).toEqual([]);
    });

    it('refuses a top-level value that is not an exact object', () => {
        for (const value of [null, [], 'record', 7, undefined]) {
            expect(decodeRtcTopologyPlanRecord(value).left).toBeTypeOf('string');
        }
    });

    it('names the refused field', () => {
        expect(decodeRtcTopologyPlanRecord({ ...REPLACING_RECORD, longestPathHops: -1 }).left).toContain(
            'longestPathHops'
        );
    });
});
