import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionReport
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { decodeALMObservationSnapshot } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    type ALMObservationRegime
} from '../../shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import type { RallarBlackBoxTestRecord } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const SENDER_AGENT_ID = 'alm-sender-w0-synthetic';
const RECEIVER_AGENT_ID = 'alm-receiver-w0-synthetic';

function toReport(reading: Omit<ALVolatileSessionReport, 'limits'>): ALVolatileSessionReport {
    return { ...reading, limits: AL_VOLATILE_SESSION_LIMITS };
}

/** A `stats` event as the control snapshot records it; `alm` absent is the control client's periodic stats. */
function toStatsEvent(
    atEpochMs: number,
    agentId: string,
    alm: ALVolatileSessionReport | RallarBlackBoxTestRecord | undefined
): RallarBlackBoxTestRecord {
    return {
        kind: 'stats',
        atEpochMs,
        agentId,
        payload: {
            kind: 'stats',
            topic: 'rallar.bb.stats',
            payload: {
                atEpochMs,
                status: 'running',
                counters: { commands: 4, events: 9, failures: 0, messages: 1, diagnostics: 3 },
                rallar: alm === undefined ? { connected: true } : { connected: true, alm }
            }
        }
    };
}

function toRegime(events: readonly RallarBlackBoxTestRecord[]): ALMObservationRegime {
    return decodeALMObservationSnapshot({ runId: 'alm-ledger', results: [], events }).fold(
        (issues) => {
            throw new Error(`synthetic snapshot did not decode: ${issues.join('; ')}`);
        },
        (snapshot) => computeALMObservationRegime({ snapshot, carrier: 'rtc', scope: 'smoke', cellOutcome: 'passed' })
    );
}

const SENDER_REPORT = toReport({
    usage: { admissions: 12, bytes: 4_800, oldestAgeMs: 2_400, tracks: 3 },
    own: { admissions: 7, bytes: 2_800 },
    inbound: { admissions: 5, bytes: 2_000 },
    overloaded: false
});
const RECEIVER_REPORT = toReport({
    usage: { admissions: 30, bytes: 1_200, oldestAgeMs: 900, tracks: 0 },
    own: { admissions: 2, bytes: 80 },
    inbound: { admissions: 28, bytes: 1_120 },
    overloaded: true
});
const LATER_SENDER_REPORT = toReport({
    usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
    own: { admissions: 0, bytes: 0 },
    inbound: { admissions: 0, bytes: 0 },
    overloaded: false
});

describe('the ALM observation ledger readings', () => {
    it('decodes each stats reading that carries a ledger per agent, skipping the periodic stats and a malformed report', () => {
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-ledger',
            results: [],
            events: [
                toStatsEvent(1_000, SENDER_AGENT_ID, SENDER_REPORT),
                toStatsEvent(1_100, SENDER_AGENT_ID, undefined),
                toStatsEvent(1_200, RECEIVER_AGENT_ID, RECEIVER_REPORT),
                toStatsEvent(1_300, RECEIVER_AGENT_ID, { usage: SENDER_REPORT.usage, limits: AL_VOLATILE_SESSION_LIMITS })
            ]
        });

        expect(decoded.right?.ledgerReadings).toEqual([
            {
                atEpochMs: 1_000,
                agentId: SENDER_AGENT_ID,
                usage: SENDER_REPORT.usage,
                own: SENDER_REPORT.own,
                inbound: SENDER_REPORT.inbound,
                overloaded: false
            },
            {
                atEpochMs: 1_200,
                agentId: RECEIVER_AGENT_ID,
                usage: RECEIVER_REPORT.usage,
                own: RECEIVER_REPORT.own,
                inbound: RECEIVER_REPORT.inbound,
                overloaded: true
            }
        ]);
    });

    it('reports the most any one page held, field by field and in the inbound pool, and how many readings were overloaded', () => {
        const regime = toRegime([
            toStatsEvent(1_000, SENDER_AGENT_ID, SENDER_REPORT),
            toStatsEvent(1_200, RECEIVER_AGENT_ID, RECEIVER_REPORT),
            toStatsEvent(4_000, SENDER_AGENT_ID, LATER_SENDER_REPORT)
        ]);

        expect(regime.ledger).toEqual({
            outcome: 'measured',
            readingCount: 3,
            maxAdmissions: 30,
            maxBytes: 4_800,
            maxOldestAgeMs: 2_400,
            maxTracks: 3,
            maxInboundAdmissions: 28,
            maxInboundBytes: 2_000,
            overloadedReadings: 1
        });
    });

    it('reports no readings for a cell whose agents read no ledger, and for an unreadable snapshot', () => {
        const regime = toRegime([toStatsEvent(1_000, SENDER_AGENT_ID, undefined)]);
        const unreadable = createUnreadableALMObservationRegime({
            carrier: 'ws',
            scope: 'smoke',
            cellOutcome: 'failed',
            snapshotIssues: ['snapshot is not an object']
        });

        expect(regime.ledger).toEqual({ outcome: 'no-readings' });
        expect(unreadable.ledger).toEqual({ outcome: 'no-readings' });
    });
});
