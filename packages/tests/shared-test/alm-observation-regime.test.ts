import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decodeALMObservationSnapshot } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import {
    ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT,
    ALM_OBSERVATION_WINDOW_MS,
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureRoot = path.join(repoRoot, 'packages/tests/shared-test/fixtures/rallar-bb-test');

// Both fixtures are trimmed copies of hosted observation runs of the rtc cell: the green head
// `c99cf654e` and the red head `902fa30a7`. Events the regime does not read were dropped, and the
// run's own earliest event was kept so the opening window still starts where it started on the
// runner. The normal fixture keeps every in-window `send`-origin commit phase (18) so the pinned
// figure matches the real cell; the slow fixture keeps its original trim.
const NORMAL_FIXTURE = 'alm-observation-normal-regime-snapshot.json';
const SLOW_FIXTURE = 'alm-observation-slow-regime-snapshot.json';

const READ_OPERATION_COUNT = 9;
const SENDER_AGENT_ID = 'alm-sender-w0-synthetic';
const RECEIVER_AGENT_ID = 'alm-receiver-w0-synthetic';
const SYNTHETIC_OUTBOUND_AGENT_ID = SENDER_AGENT_ID;
const INBOUND_WORKER_ID = 'al-inbound:worker-1';

function readFixtureRegime(
    fixtureName: string,
    cellOutcome: ALMObservationCellOutcome
): ALMObservationRegime {
    const value = JSON.parse(
        readFileSync(path.join(fixtureRoot, fixtureName), 'utf8')
    ) as unknown;
    return decodeALMObservationSnapshot(value).fold(
        (issues) => {
            throw new Error(`${fixtureName} did not decode: ${issues.join('; ')}`);
        },
        (snapshot) => computeALMObservationRegime({ snapshot, carrier: 'rtc', scope: 'smoke', cellOutcome })
    );
}

function toCommitPhaseEvent(
    atEpochMs: number,
    msPerOperation: number,
    origin: string
): Record<string, unknown> {
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId: SYNTHETIC_OUTBOUND_AGENT_ID,
        payload: {
            topic: 'rallar.browser.alm.outbound_diagnostics',
            payload: {
                data: {
                    kind: 'commit-phases',
                    origin,
                    readDurationMs: msPerOperation * READ_OPERATION_COUNT,
                    readOperationCount: READ_OPERATION_COUNT
                }
            }
        }
    };
}

function toInboundOutcomeEvent(
    atEpochMs: number,
    agentId: string,
    outcome: string
): Record<string, unknown> {
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId,
        payload: {
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: { kind: 'admission-outcome', workerId: INBOUND_WORKER_ID, outcome }
            }
        }
    };
}

function toInboundDrainEvent(
    atEpochMs: number,
    agentId: string,
    phases: Readonly<{
        durationMs: number;
        selectionDurationMs: number;
        claimDurationMs: number;
        runDurationMs: number;
        releaseDurationMs: number;
        queueWaitMs: number;
    }>
): Record<string, unknown> {
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId,
        payload: {
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: { kind: 'effect-drain', workerId: INBOUND_WORKER_ID, ...phases }
            }
        }
    };
}

function toSyntheticRegime(events: readonly Record<string, unknown>[]): ALMObservationRegime {
    return decodeALMObservationSnapshot({ runId: 'alm-synthetic', results: [], events }).fold(
        (issues) => {
            throw new Error(`synthetic snapshot did not decode: ${issues.join('; ')}`);
        },
        (snapshot) =>
            computeALMObservationRegime({
                snapshot,
                carrier: 'rtc',
                scope: 'smoke',
                cellOutcome: 'passed'
            })
    );
}

function toEvenlySpacedCommitPhases(
    msPerOperation: number,
    count: number,
    origin = 'send'
): readonly Record<string, unknown>[] {
    return Array.from(
        { length: count },
        (_unused, index) => toCommitPhaseEvent(1_000 + index * 100, msPerOperation, origin)
    );
}

describe('computeALMObservationRegime', () => {
    it('classifies the green hosted run as the normal regime', () => {
        const regime = readFixtureRegime(NORMAL_FIXTURE, 'passed');

        expect(regime.regime).toBe('normal');
        expect(regime.perOperation).toEqual({
            outcome: 'measured',
            medianMs: 24.06,
            sampleCount: 18
        });
        expect(regime.runId).toBe('alm-rtc-1789077925043-04591945-9cb6-4db4-a5');
        expect(regime.carrier).toBe('rtc');
        expect(regime.scope).toBe('smoke');
        expect(regime.cellOutcome).toBe('passed');
        expect(regime.windowMs).toBe(ALM_OBSERVATION_WINDOW_MS);
        expect(regime.snapshotIssues).toEqual([]);
        expect(regime.inbound).toEqual([]);
    });

    it('reports both peers ready and the work-page rate for the green hosted run', () => {
        const regime = readFixtureRegime(NORMAL_FIXTURE, 'passed');

        expect(regime.peerReadiness).toEqual([
            {
                outcome: 'ready',
                sessionId: 'session-2tZv69x9zf99PN5sfpOVy4Mm',
                peerId: 'session-irz4krf9K0CMcvowEz-spCdE',
                readinessMs: 17_880
            },
            {
                outcome: 'ready',
                sessionId: 'session-irz4krf9K0CMcvowEz-spCdE',
                peerId: 'session-2tZv69x9zf99PN5sfpOVy4Mm',
                readinessMs: 12_360
            }
        ]);
        expect(regime.workPageRate).toEqual({
            outcome: 'measured',
            perSecond: 3.15,
            readingCount: 4,
            spanMs: 67_293
        });
    });

    it('records the wall clock of every scenario recipe run that completed', () => {
        const regime = readFixtureRegime(NORMAL_FIXTURE, 'passed');

        expect(regime.scenarioSends).toHaveLength(6);
        expect(regime.scenarioSends[0]).toEqual({
            outcome: 'completed',
            commandId: 'alm-rtc-bounded-rejection-sender-run',
            recipeId: 'alm-rtc-bounded-rejection-sender',
            durationMs: 25_266
        });
    });

    it('classifies the red hosted run as the slow regime', () => {
        const regime = readFixtureRegime(SLOW_FIXTURE, 'failed');

        expect(regime.regime).toBe('slow');
        expect(regime.perOperation).toEqual({
            outcome: 'measured',
            medianMs: 36,
            sampleCount: 7
        });
        expect(regime.cellOutcome).toBe('failed');
        expect(regime.inbound).toEqual([]);
    });

    it('names the failing step code and the never-ready peers of the red hosted run', () => {
        const regime = readFixtureRegime(SLOW_FIXTURE, 'failed');

        expect(regime.scenarioSends).toHaveLength(6);
        expect(regime.scenarioSends.every((send) => send.outcome === 'failed' && send.failureCode === 'RALLAR_BB_RTC_READY_TIMEOUT')).toBe(true);
        expect(regime.peerReadiness.map((peer) => peer.outcome)).toEqual([
            'never-ready',
            'never-ready'
        ]);
        expect(regime.workPageRate).toEqual({ outcome: 'too-few-readings', readingCount: 0 });
    });

    it('leaves the band between the two thresholds unclassified', () => {
        const regime = toSyntheticRegime(toEvenlySpacedCommitPhases(32, 7));

        expect(regime.regime).toBe('unclassified');
        expect(regime.perOperation).toEqual({
            outcome: 'measured',
            medianMs: 32,
            sampleCount: 7
        });
    });

    it('classifies the two edges of the band', () => {
        expect(toSyntheticRegime(toEvenlySpacedCommitPhases(29.99, 7)).regime).toBe('normal');
        expect(toSyntheticRegime(toEvenlySpacedCommitPhases(30, 7)).regime).toBe('unclassified');
        expect(toSyntheticRegime(toEvenlySpacedCommitPhases(34.99, 7)).regime).toBe('unclassified');
        expect(toSyntheticRegime(toEvenlySpacedCommitPhases(35, 7)).regime).toBe('slow');
    });

    it('refuses to classify fewer commit phases than the minimum', () => {
        const regime = toSyntheticRegime(
            toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT - 1)
        );

        expect(regime.regime).toBe('unclassified');
        expect(regime.perOperation).toEqual({
            outcome: 'too-few-samples',
            sampleCount: ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT - 1
        });
    });

    it('measures the opening window rather than the whole cell', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, 5),
            toCommitPhaseEvent(1_000 + ALM_OBSERVATION_WINDOW_MS + 1, 400, 'send'),
            toCommitPhaseEvent(1_000 + ALM_OBSERVATION_WINDOW_MS + 2, 400, 'send')
        ]);

        expect(regime.perOperation).toEqual({ outcome: 'measured', medianMs: 12, sampleCount: 5 });
        expect(regime.regime).toBe('normal');
    });

    it('measures a caller admission rather than the drain commit behind it', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, 5),
            ...toEvenlySpacedCommitPhases(400, 5, 'drain')
        ]);

        expect(regime.perOperation).toEqual({ outcome: 'measured', medianMs: 12, sampleCount: 5 });
    });

    it('computes the pending share and drain phase medians per inbound direction', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            toInboundOutcomeEvent(1_000, RECEIVER_AGENT_ID, 'pending'),
            toInboundOutcomeEvent(1_001, RECEIVER_AGENT_ID, 'pending'),
            toInboundOutcomeEvent(1_002, RECEIVER_AGENT_ID, 'pending'),
            toInboundOutcomeEvent(1_003, RECEIVER_AGENT_ID, 'committed'),
            toInboundOutcomeEvent(1_004, SENDER_AGENT_ID, 'pending'),
            toInboundOutcomeEvent(1_005, SENDER_AGENT_ID, 'committed'),
            toInboundDrainEvent(1_006, SENDER_AGENT_ID, {
                durationMs: 100,
                selectionDurationMs: 10,
                claimDurationMs: 5,
                runDurationMs: 50,
                releaseDurationMs: 8,
                queueWaitMs: 3
            }),
            toInboundDrainEvent(1_007, SENDER_AGENT_ID, {
                durationMs: 200,
                selectionDurationMs: 20,
                claimDurationMs: 15,
                runDurationMs: 70,
                releaseDurationMs: 12,
                queueWaitMs: 7
            }),
            toInboundDrainEvent(1_008, RECEIVER_AGENT_ID, {
                durationMs: 300,
                selectionDurationMs: 30,
                claimDurationMs: 25,
                runDurationMs: 150,
                releaseDurationMs: 18,
                queueWaitMs: 13
            }),
            toInboundDrainEvent(1_009, RECEIVER_AGENT_ID, {
                durationMs: 400,
                selectionDurationMs: 40,
                claimDurationMs: 35,
                runDurationMs: 170,
                releaseDurationMs: 22,
                queueWaitMs: 17
            })
        ]);

        expect(regime.inbound).toEqual([
            {
                role: 'sender',
                outcome: 'measured',
                pendingSharePercent: 50,
                outcomeCount: 2,
                phases: {
                    selectionMedianMs: 15,
                    claimMedianMs: 10,
                    runMedianMs: 60,
                    releaseMedianMs: 10,
                    queueWaitMedianMs: 5,
                    drainMedianMs: 150,
                    drainCount: 2
                }
            },
            {
                role: 'receiver',
                outcome: 'measured',
                pendingSharePercent: 75,
                outcomeCount: 4,
                phases: {
                    selectionMedianMs: 35,
                    claimMedianMs: 30,
                    runMedianMs: 160,
                    releaseMedianMs: 20,
                    queueWaitMedianMs: 15,
                    drainMedianMs: 350,
                    drainCount: 2
                }
            },
            { role: 'unattributed', outcome: 'no-events' }
        ]);
    });

    it('reports a measured direction with zero drain medians when a role has outcomes but no drains', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            toInboundOutcomeEvent(1_000, SENDER_AGENT_ID, 'pending')
        ]);

        expect(regime.inbound).toEqual([
            {
                role: 'sender',
                outcome: 'measured',
                pendingSharePercent: 100,
                outcomeCount: 1,
                phases: {
                    selectionMedianMs: 0,
                    claimMedianMs: 0,
                    runMedianMs: 0,
                    releaseMedianMs: 0,
                    queueWaitMedianMs: 0,
                    drainMedianMs: 0,
                    drainCount: 0
                }
            },
            { role: 'receiver', outcome: 'no-events' },
            { role: 'unattributed', outcome: 'no-events' }
        ]);
    });

    it('summarizes a cell in one line for the job log', () => {
        expect(toALMObservationRegimeSummary(readFixtureRegime(SLOW_FIXTURE, 'failed'))).toBe(
            'ALM observation rtc-smoke: regime=slow perOperation=36 ms/op over 7 commits outcome=failed'
        );
        expect(
            toALMObservationRegimeSummary(
                createUnreadableALMObservationRegime({
                    carrier: 'ws',
                    scope: 'smoke',
                    cellOutcome: 'failed',
                    snapshotIssues: ['snapshot is not an object']
                })
            )
        ).toBe(
            'ALM observation ws-smoke: regime=unclassified perOperation=unmeasured (0 commits) outcome=failed'
        );
    });
});

describe('createUnreadableALMObservationRegime', () => {
    it('carries the decode issues so an unreadable cell still leaves a file', () => {
        const regime = createUnreadableALMObservationRegime({
            carrier: 'rtc-with-ws-fallback',
            scope: 'full',
            cellOutcome: 'failed',
            snapshotIssues: ['snapshot is not an object']
        });

        expect(regime.regime).toBe('unclassified');
        expect(regime.snapshotIssues).toEqual(['snapshot is not an object']);
        expect(regime.carrier).toBe('rtc-with-ws-fallback');
        expect(regime.scope).toBe('full');
        expect(regime.scenarioSends).toEqual([]);
    });
});

describe('decodeALMObservationSnapshot', () => {
    it('rejects a value that is not an object', () => {
        expect(decodeALMObservationSnapshot(42).left).toEqual(['snapshot is not an object']);
    });

    it('reports every missing part of an unusable snapshot at once', () => {
        expect(decodeALMObservationSnapshot({ events: [], results: {} }).left).toEqual([
            'snapshot.runId is not a string',
            'snapshot.results is not an array',
            'snapshot.events carries no timestamped event'
        ]);
    });

    it('decodes inbound admission outcomes and drains per agent role', () => {
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-inbound-synthetic',
            results: [],
            events: [
                ...toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
                toInboundOutcomeEvent(1_000, RECEIVER_AGENT_ID, 'pending'),
                toInboundOutcomeEvent(1_001, RECEIVER_AGENT_ID, 'pending'),
                toInboundOutcomeEvent(1_002, RECEIVER_AGENT_ID, 'pending'),
                toInboundOutcomeEvent(1_003, RECEIVER_AGENT_ID, 'committed'),
                toInboundOutcomeEvent(1_004, SENDER_AGENT_ID, 'pending'),
                toInboundOutcomeEvent(1_005, SENDER_AGENT_ID, 'committed'),
                toInboundDrainEvent(1_006, SENDER_AGENT_ID, {
                    durationMs: 100,
                    selectionDurationMs: 10,
                    claimDurationMs: 5,
                    runDurationMs: 50,
                    releaseDurationMs: 8,
                    queueWaitMs: 3
                }),
                toInboundDrainEvent(1_007, SENDER_AGENT_ID, {
                    durationMs: 200,
                    selectionDurationMs: 20,
                    claimDurationMs: 15,
                    runDurationMs: 70,
                    releaseDurationMs: 12,
                    queueWaitMs: 7
                }),
                toInboundDrainEvent(1_008, RECEIVER_AGENT_ID, {
                    durationMs: 300,
                    selectionDurationMs: 30,
                    claimDurationMs: 25,
                    runDurationMs: 150,
                    releaseDurationMs: 18,
                    queueWaitMs: 13
                }),
                toInboundDrainEvent(1_009, RECEIVER_AGENT_ID, {
                    durationMs: 400,
                    selectionDurationMs: 40,
                    claimDurationMs: 35,
                    runDurationMs: 170,
                    releaseDurationMs: 22,
                    queueWaitMs: 17
                })
            ]
        });

        expect(decoded.left).toBeUndefined();
        expect(decoded.right?.inboundOutcomes).toHaveLength(6);
        expect(decoded.right?.inboundOutcomes.map((outcome) => outcome.role)).toEqual([
            'receiver',
            'receiver',
            'receiver',
            'receiver',
            'sender',
            'sender'
        ]);
        expect(decoded.right?.inboundDrains).toHaveLength(4);
        expect(decoded.right?.inboundDrains.map((drain) => drain.role)).toEqual([
            'sender',
            'sender',
            'receiver',
            'receiver'
        ]);
    });

    it('skips the events it does not read instead of rejecting the snapshot', () => {
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-mixed',
            results: [],
            events: [
                { kind: 'diagnostic', atEpochMs: 1_000, payload: { topic: 'rallar.browser.ws.lifecycle' } },
                toCommitPhaseEvent(1_100, 12, 'send')
            ]
        });

        expect(decoded.left).toBeUndefined();
        expect(decoded.right?.commitPhases).toHaveLength(1);
        expect(decoded.right?.firstEventAtEpochMs).toBe(1_000);
    });
});
