import { describe, expect, it } from 'vitest';

import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { decodeALMObservationSnapshot } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import {
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    type ALMObservationRegime
} from '../../shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import type { RallarBlackBoxTestRecord } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const SENDER_AGENT_ID = 'alm-sender-w0-synthetic';
const RECEIVER_AGENT_ID = 'alm-receiver-w0-synthetic';

/** A `stats` event as the control snapshot records it; `congestion` absent is the control client's periodic stats. */
function toStatsEvent(
    atEpochMs: number,
    agentId: string,
    congestion: ALCongestionCounters | RallarBlackBoxTestRecord | undefined
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
                rallar: congestion === undefined ? { connected: true } : { connected: true, congestion }
            }
        }
    };
}

function toRegime(events: readonly RallarBlackBoxTestRecord[]): ALMObservationRegime {
    return decodeALMObservationSnapshot({ runId: 'alm-congestion', results: [], events }).fold(
        (issues) => {
            throw new Error(`synthetic snapshot did not decode: ${issues.join('; ')}`);
        },
        (snapshot) => computeALMObservationRegime({ snapshot, carrier: 'rtc', scope: 'full', cellOutcome: 'passed' })
    );
}

describe('the ALM observation congestion readings', () => {
    it('decodes each stats reading that carries congestion counters per agent, skipping the periodic stats and malformed counters', () => {
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-congestion',
            results: [],
            events: [
                toStatsEvent(1_000, SENDER_AGENT_ID, { dropped: 1, deferred: 0, handedOver: 1 }),
                toStatsEvent(1_100, SENDER_AGENT_ID, undefined),
                toStatsEvent(1_200, RECEIVER_AGENT_ID, { dropped: 0, deferred: 0 })
            ]
        });

        expect(decoded.right?.congestionReadings).toEqual([
            { atEpochMs: 1_000, agentId: SENDER_AGENT_ID, counters: { dropped: 1, deferred: 0, handedOver: 1 } }
        ]);
    });

    it('sums each page\'s largest count across the cell\'s pages', () => {
        const regime = toRegime([
            toStatsEvent(1_000, SENDER_AGENT_ID, { dropped: 1, deferred: 2, handedOver: 1 }),
            toStatsEvent(2_000, SENDER_AGENT_ID, { dropped: 1, deferred: 5, handedOver: 1 }),
            toStatsEvent(2_500, RECEIVER_AGENT_ID, { dropped: 0, deferred: 3, handedOver: 0 }),
            toStatsEvent(4_000, SENDER_AGENT_ID, { dropped: 0, deferred: 1, handedOver: 0 })
        ]);

        expect(regime.congestion).toEqual({ outcome: 'measured', readingCount: 4, dropped: 1, deferred: 8, handedOver: 1 });
    });

    it('reports no readings for a cell whose agents read no counters, and for an unreadable snapshot', () => {
        const regime = toRegime([toStatsEvent(1_000, SENDER_AGENT_ID, undefined)]);
        const unreadable = createUnreadableALMObservationRegime({
            carrier: 'ws',
            scope: 'full',
            cellOutcome: 'failed',
            snapshotIssues: ['snapshot is not an object']
        });

        expect(regime.congestion).toEqual({ outcome: 'no-readings' });
        expect(unreadable.congestion).toEqual({ outcome: 'no-readings' });
    });
});
