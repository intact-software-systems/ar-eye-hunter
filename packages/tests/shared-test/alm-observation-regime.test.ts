import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ALMObservationPageDiagnosticsFile } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts';
import { decodeALMObservationSnapshot } from '../../shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
import {
    ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT,
    ALM_OBSERVATION_PAGE_WINDOW_END_MS
} from '../../shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-page-regime.ts';
import {
    ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT,
    ALM_OBSERVATION_WINDOW_MS,
    computeALMObservationRegime,
    createUnreadableALMObservationRegime,
    toALMObservationRegimeSummary,
    type ALMObservationCellOutcome,
    type ALMObservationRegime
} from '../../shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';
import type { RallarBlackBoxTestRecord } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

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
const NO_CLAIM_WAITS = {
    reservationWaitMedianMs: 0,
    intraBatchWaitMedianMs: 0,
    dispatchClaimCount: 0,
    sendControlClaimMedianMs: 0,
    sendControlClaimCount: 0
};

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
): RallarBlackBoxTestRecord {
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

function toReadinessProbeEvent(
    atEpochMs: number,
    agentId: string,
    probe: Readonly<{ cause: string; durationMs: number; }>
): RallarBlackBoxTestRecord {
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId,
        payload: {
            topic: 'rallar.browser.alm.outbound_diagnostics',
            payload: {
                data: { kind: 'readiness-probe', workerId: 'al-outbound:worker-1', readyAtMs: 'none', ...probe }
            }
        }
    };
}

/** `count` probes a second apart inside the page window; the anchor commit keeps the run's first event at 1 000. */
function toPageWindowProbes(
    durationMs: number,
    count: number,
    cause = 'age-bound'
): readonly RallarBlackBoxTestRecord[] {
    return [
        toCommitPhaseEvent(1_000, 12, 'send'),
        ...Array.from({ length: count }, (_unused, index) =>
            toReadinessProbeEvent(
                1_000 + ALM_OBSERVATION_WINDOW_MS + 1_000 * (index + 1),
                index % 2 === 0 ? SENDER_AGENT_ID : RECEIVER_AGENT_ID,
                { cause, durationMs }
            ))
    ];
}

/** One message per event unless `identity` names it, admitted over WS unless it names the carrier and reason. */
function toInboundOutcomeEvent(
    atEpochMs: number,
    agentId: string,
    outcome: string,
    identity: Readonly<{ msgId?: string; carrier?: string; reason?: string; }> = {}
): RallarBlackBoxTestRecord {
    const data = {
        kind: 'admission-outcome',
        workerId: INBOUND_WORKER_ID,
        msgId: `msg-${atEpochMs}`,
        typeId: 'alm.conformance',
        carrier: 'ws',
        outcome,
        reason: outcome === 'committed' ? 'admitted' : 'pending-admission',
        ...identity
    };
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId,
        payload: { topic: 'rallar.browser.alm.inbound_diagnostics', payload: { data } }
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
): RallarBlackBoxTestRecord {
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

function toInboundClaimEvent(
    atEpochMs: number,
    agentId: string,
    claim: Readonly<{
        payloadKind: string;
        durationMs: number;
        dueAtMs: number;
        batchStartedAtMs: number;
        startedAtMs: number;
    }>
): RallarBlackBoxTestRecord {
    return {
        kind: 'diagnostic',
        atEpochMs,
        agentId,
        payload: {
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: { kind: 'claim-settled', workerId: INBOUND_WORKER_ID, ...claim }
            }
        }
    };
}

/** A `dispatch-local` claim whose two wait halves are the given figures, after a batch that started at 10 000. */
function toDispatchClaimEvent(
    atEpochMs: number,
    reservationWaitMs: number,
    intraBatchWaitMs: number
): RallarBlackBoxTestRecord {
    const batchStartedAtMs = 10_000;
    return toInboundClaimEvent(atEpochMs, RECEIVER_AGENT_ID, {
        payloadKind: 'dispatch-local',
        durationMs: 5,
        dueAtMs: batchStartedAtMs - reservationWaitMs,
        batchStartedAtMs,
        startedAtMs: batchStartedAtMs + intraBatchWaitMs
    });
}

function toSyntheticRegime(
    events: readonly RallarBlackBoxTestRecord[],
    pageDiagnosticsFile?: ALMObservationPageDiagnosticsFile
): ALMObservationRegime {
    return decodeALMObservationSnapshot({ runId: 'alm-synthetic', results: [], events }).fold(
        (issues) => {
            throw new Error(`synthetic snapshot did not decode: ${issues.join('; ')}`);
        },
        (snapshot) =>
            computeALMObservationRegime({
                snapshot,
                carrier: 'rtc',
                scope: 'smoke',
                cellOutcome: 'passed',
                pageDiagnosticsFile
            })
    );
}

function toEvenlySpacedCommitPhases(
    msPerOperation: number,
    count: number,
    origin = 'send'
): readonly RallarBlackBoxTestRecord[] {
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
        expect(regime.pageRegime).toEqual({ outcome: 'unmeasured', sampleCount: 0, regime: 'unclassified' });
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
        expect(regime.pageRegime).toEqual({ outcome: 'unmeasured', sampleCount: 0, regime: 'unclassified' });
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

    it('classifies the page from the median age-bound probe, unmoved by probes outside its window or cause', () => {
        const regime = toSyntheticRegime([
            ...toPageWindowProbes(2, 10),
            ...Array.from({ length: 5 }, (_unused, index) => toReadinessProbeEvent(1_000 + index, SENDER_AGENT_ID, { cause: 'age-bound', durationMs: 400 })),
            ...Array.from({ length: 5 }, (_unused, index) =>
                toReadinessProbeEvent(
                    1_000 + ALM_OBSERVATION_WINDOW_MS + 1_000 * (index + 1),
                    RECEIVER_AGENT_ID,
                    { cause: 'own-commit', durationMs: 400 }
                )),
            ...Array.from({ length: 5 }, (_unused, index) =>
                toReadinessProbeEvent(
                    1_000 + ALM_OBSERVATION_PAGE_WINDOW_END_MS + 1_000 * (index + 1),
                    SENDER_AGENT_ID,
                    { cause: 'age-bound', durationMs: 400 }
                ))
        ]);

        expect(regime.pageRegime).toEqual({
            outcome: 'measured',
            storageProbeMedianMs: 2,
            sampleCount: 10,
            regime: 'normal'
        });
    });

    it('classifies the page as slow at 120 ms and unclassified in the band at 30 ms', () => {
        expect(toSyntheticRegime(toPageWindowProbes(120, 10)).pageRegime).toEqual({
            outcome: 'measured',
            storageProbeMedianMs: 120,
            sampleCount: 10,
            regime: 'slow'
        });
        expect(toSyntheticRegime(toPageWindowProbes(30, 10)).pageRegime).toEqual({
            outcome: 'measured',
            storageProbeMedianMs: 30,
            sampleCount: 10,
            regime: 'unclassified'
        });
    });

    it('classifies the two edges of the page band', () => {
        expect(toSyntheticRegime(toPageWindowProbes(19.99, 10)).pageRegime.regime).toBe('normal');
        expect(toSyntheticRegime(toPageWindowProbes(20, 10)).pageRegime.regime).toBe('unclassified');
        expect(toSyntheticRegime(toPageWindowProbes(49.99, 10)).pageRegime.regime).toBe('unclassified');
        expect(toSyntheticRegime(toPageWindowProbes(50, 10)).pageRegime.regime).toBe('slow');
    });

    it('refuses to classify the page from fewer probes than the minimum', () => {
        const regime = toSyntheticRegime(toPageWindowProbes(2, ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT - 1));

        expect(regime.pageRegime).toEqual({
            outcome: 'unmeasured',
            sampleCount: ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT - 1,
            regime: 'unclassified'
        });
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
                pendingShare: { outcome: 'measured', pendingSharePercent: 50, outcomeCount: 2 },
                phases: {
                    selectionMedianMs: 15,
                    claimMedianMs: 10,
                    runMedianMs: 60,
                    releaseMedianMs: 10,
                    queueWaitMedianMs: 5,
                    drainMedianMs: 150,
                    drainCount: 2
                },
                claimWaits: NO_CLAIM_WAITS
            },
            {
                role: 'receiver',
                outcome: 'measured',
                pendingShare: { outcome: 'measured', pendingSharePercent: 75, outcomeCount: 4 },
                phases: {
                    selectionMedianMs: 35,
                    claimMedianMs: 30,
                    runMedianMs: 160,
                    releaseMedianMs: 20,
                    queueWaitMedianMs: 15,
                    drainMedianMs: 350,
                    drainCount: 2
                },
                claimWaits: NO_CLAIM_WAITS
            },
            { role: 'unattributed', outcome: 'no-events' }
        ]);
    });

    it('splits the receiver\'s delivery wait into its reservation and intra-batch halves', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            toInboundOutcomeEvent(1_000, SENDER_AGENT_ID, 'committed'),
            toDispatchClaimEvent(1_001, 100, 4_000),
            toDispatchClaimEvent(1_002, 200, 5_000),
            toDispatchClaimEvent(1_003, 300, 6_000),
            toInboundClaimEvent(1_004, RECEIVER_AGENT_ID, {
                payloadKind: 'send-control',
                durationMs: 3_000,
                dueAtMs: 9_000,
                batchStartedAtMs: 10_000,
                startedAtMs: 10_000
            }),
            toInboundClaimEvent(1_005, RECEIVER_AGENT_ID, {
                payloadKind: 'send-control',
                durationMs: 5_000,
                dueAtMs: 9_000,
                batchStartedAtMs: 10_000,
                startedAtMs: 13_000
            })
        ]);

        const claimWaitsOf = (role: string) => {
            const direction = regime.inbound.find((candidate) => candidate.role === role);
            return direction?.outcome === 'measured' ? direction.claimWaits : undefined;
        };
        expect(claimWaitsOf('receiver')).toEqual({
            reservationWaitMedianMs: 200,
            intraBatchWaitMedianMs: 5_000,
            dispatchClaimCount: 3,
            sendControlClaimMedianMs: 4_000,
            sendControlClaimCount: 2
        });
        expect(claimWaitsOf('sender')).toEqual(NO_CLAIM_WAITS);
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
                pendingShare: { outcome: 'measured', pendingSharePercent: 100, outcomeCount: 1 },
                phases: {
                    selectionMedianMs: 0,
                    claimMedianMs: 0,
                    runMedianMs: 0,
                    releaseMedianMs: 0,
                    queueWaitMedianMs: 0,
                    drainMedianMs: 0,
                    drainCount: 0
                },
                claimWaits: NO_CLAIM_WAITS
            },
            { role: 'receiver', outcome: 'no-events' },
            { role: 'unattributed', outcome: 'no-events' }
        ]);
    });

    it('reports pending share as unmeasured when a role has drains but no admission outcomes', () => {
        const regime = toSyntheticRegime([
            ...toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            toInboundDrainEvent(1_000, SENDER_AGENT_ID, {
                durationMs: 100,
                selectionDurationMs: 10,
                claimDurationMs: 5,
                runDurationMs: 50,
                releaseDurationMs: 8,
                queueWaitMs: 3
            })
        ]);

        expect(regime.inbound).toEqual([
            {
                role: 'sender',
                outcome: 'measured',
                pendingShare: { outcome: 'unmeasured' },
                phases: {
                    selectionMedianMs: 10,
                    claimMedianMs: 5,
                    runMedianMs: 50,
                    releaseMedianMs: 8,
                    queueWaitMedianMs: 3,
                    drainMedianMs: 100,
                    drainCount: 1
                },
                claimWaits: NO_CLAIM_WAITS
            },
            { role: 'receiver', outcome: 'no-events' },
            { role: 'unattributed', outcome: 'no-events' }
        ]);
    });

    it('summarizes a cell in one line for the job log', () => {
        expect(toALMObservationRegimeSummary(readFixtureRegime(SLOW_FIXTURE, 'failed'))).toBe(
            'ALM observation rtc-smoke: regime=slow perOperation=36 ms/op over 7 commits outcome=failed ' +
                'page=unclassified (unmeasured, 0 probes)'
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
            'ALM observation ws-smoke: regime=unclassified perOperation=unmeasured (0 commits) outcome=failed ' +
                'page=unclassified (unmeasured, 0 probes)'
        );
    });

    it('summarizes a measured page regime with its median and sample count', () => {
        const regime = toSyntheticRegime(toPageWindowProbes(2, 10));

        expect(toALMObservationRegimeSummary(regime)).toContain('page=normal (2 ms/probe over 10)');
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

describe('page diagnostics on the regime', () => {
    it('reports not-captured when the lane supplied no page diagnostics file', () => {
        const regime = toSyntheticRegime(toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT));

        expect(regime.pageDiagnostics).toEqual({ outcome: 'not-captured' });
    });

    it('reports the unreadable regime as not-captured too, absent a file', () => {
        const regime = createUnreadableALMObservationRegime({
            carrier: 'ws',
            scope: 'smoke',
            cellOutcome: 'failed',
            snapshotIssues: ['snapshot is not an object']
        });

        expect(regime.pageDiagnostics).toEqual({ outcome: 'not-captured' });
    });

    it('reports the unreadable regime as captured when the lane did supply a file', () => {
        const regime = createUnreadableALMObservationRegime({
            carrier: 'ws',
            scope: 'smoke',
            cellOutcome: 'failed',
            snapshotIssues: ['snapshot is not an object'],
            pageDiagnosticsFile: { droppedCount: 0, records: [] }
        });

        expect(regime.pageDiagnostics).toEqual({
            outcome: 'captured',
            counts: { pageerror: 0, consoleError: 0, consoleWarning: 0 },
            dropped: 0,
            first: []
        });
    });

    it('counts each kind, carries dropped, and orders the earliest records first', () => {
        const pageDiagnosticsFile: ALMObservationPageDiagnosticsFile = {
            droppedCount: 3,
            records: [
                { agentId: SENDER_AGENT_ID, role: 'sender', atMs: 500, kind: 'console-error', message: 'later' },
                {
                    agentId: RECEIVER_AGENT_ID,
                    role: 'receiver',
                    atMs: 100,
                    kind: 'pageerror',
                    message: 'earlier',
                    stack: 'trace'
                },
                { agentId: SENDER_AGENT_ID, role: 'sender', atMs: 300, kind: 'console-warning', message: 'middle' }
            ]
        };

        const regime = toSyntheticRegime(
            toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            pageDiagnosticsFile
        );

        expect(regime.pageDiagnostics).toEqual({
            outcome: 'captured',
            counts: { pageerror: 1, consoleError: 1, consoleWarning: 1 },
            dropped: 3,
            first: [
                pageDiagnosticsFile.records[1],
                pageDiagnosticsFile.records[2],
                pageDiagnosticsFile.records[0]
            ]
        });
    });

    it('bounds the earliest-records list at 20', () => {
        const records = Array.from({ length: 25 }, (_unused, index) => ({
            agentId: SENDER_AGENT_ID,
            role: 'sender' as const,
            atMs: index,
            kind: 'console-error' as const,
            message: `message-${index}`
        }));

        const regime = toSyntheticRegime(
            toEvenlySpacedCommitPhases(12, ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT),
            { records, droppedCount: 0 }
        );

        expect(regime.pageDiagnostics.outcome).toBe('captured');
        expect(regime.pageDiagnostics.outcome === 'captured' ? regime.pageDiagnostics.first : []).toHaveLength(20);
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

    it('decodes a claim-settled event and skips one missing a wait instant', () => {
        // A claim emitted before the wait instants existed: it names no batch start.
        const legacyClaim = {
            kind: 'diagnostic',
            atEpochMs: 1_002,
            agentId: RECEIVER_AGENT_ID,
            payload: {
                topic: 'rallar.browser.alm.inbound_diagnostics',
                payload: {
                    data: {
                        kind: 'claim-settled',
                        workerId: INBOUND_WORKER_ID,
                        payloadKind: 'dispatch-local',
                        durationMs: 5,
                        dueAtMs: 1,
                        startedAtMs: 3
                    }
                }
            }
        };
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-claims',
            results: [],
            events: [toDispatchClaimEvent(1_001, 100, 4_000), legacyClaim]
        });

        expect(decoded.right?.inboundClaims).toEqual([{
            atEpochMs: 1_001,
            role: 'receiver',
            workerId: INBOUND_WORKER_ID,
            payloadKind: 'dispatch-local',
            durationMs: 5,
            dueAtMs: 9_900,
            batchStartedAtMs: 10_000,
            startedAtMs: 14_000
        }]);
    });

    it('decodes a readiness-probe per agent role and skips one missing a cause or a finite duration', () => {
        const missingCause = {
            kind: 'diagnostic',
            atEpochMs: 1_002,
            agentId: SENDER_AGENT_ID,
            payload: {
                topic: 'rallar.browser.alm.outbound_diagnostics',
                payload: {
                    data: { kind: 'readiness-probe', workerId: 'al-outbound:worker-1', readyAtMs: 'none', durationMs: 12 }
                }
            }
        };
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-probes',
            results: [],
            events: [
                toReadinessProbeEvent(1_000, SENDER_AGENT_ID, { cause: 'age-bound', durationMs: 12 }),
                toReadinessProbeEvent(1_001, RECEIVER_AGENT_ID, { cause: 'own-commit', durationMs: 8 }),
                missingCause
            ]
        });

        expect(decoded.right?.readinessProbes).toEqual([
            { atEpochMs: 1_000, role: 'sender', cause: 'age-bound', durationMs: 12 },
            { atEpochMs: 1_001, role: 'receiver', cause: 'own-commit', durationMs: 8 }
        ]);
    });

    it('keeps each inbound outcome\'s msgId, carrier and reason, so one message arriving twice pairs up', () => {
        const decoded = decodeALMObservationSnapshot({
            runId: 'alm-cross-carrier-duplicate',
            results: [],
            events: [
                toInboundOutcomeEvent(1_000, RECEIVER_AGENT_ID, 'committed', { msgId: 'm-1', carrier: 'rtc' }),
                toInboundOutcomeEvent(1_001, RECEIVER_AGENT_ID, 'not-handled', { msgId: 'm-1', reason: 'duplicate' }),
                toInboundOutcomeEvent(1_002, RECEIVER_AGENT_ID, 'committed', { carrier: 'quic' }),
                toInboundOutcomeEvent(1_003, RECEIVER_AGENT_ID, 'committed', { reason: '' })
            ]
        });

        expect(decoded.right?.inboundOutcomes).toEqual([
            { atEpochMs: 1_000, role: 'receiver', workerId: INBOUND_WORKER_ID, msgId: 'm-1', carrier: 'rtc', outcome: 'committed', reason: 'admitted' },
            { atEpochMs: 1_001, role: 'receiver', workerId: INBOUND_WORKER_ID, msgId: 'm-1', carrier: 'ws', outcome: 'not-handled', reason: 'duplicate' }
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
