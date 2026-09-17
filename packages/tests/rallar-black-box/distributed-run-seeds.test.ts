import { describe, expect, it } from 'vitest';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView
} from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    createSyntheticDistributedRunSeed,
    DISTRIBUTED_RUN_SEEDS,
    distributedRunSeedIdFromValue
} from '../../../apps/rallar-black-box/src/distributed-run-seeds.ts';
import { computeRtcDiagnostics, computeRtcPerformanceView } from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';
import { computeDistributedRunArtifactAnalysis } from '../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { RallarBlackBoxTestState } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The clock each RTC diagnostics case reads, so the generated bundle time is deterministic. */
const DIAGNOSTICS_NOW_EPOCH_MS = 100_000;

function verdictFor(seedId: Parameters<typeof createSyntheticDistributedRunSeed>[0]) {
    const seed = createSyntheticDistributedRunSeed(seedId);
    const monitor = deriveDistributedRunMonitor({
        distributedRun: seed.distributedRun,
        controlRun: seed.controlRun,
        artifactBundle: seed.artifactBundle
    });
    const report = deriveDistributedRunAnalysisReport({
        distributedRun: seed.distributedRun,
        controlRun: seed.controlRun,
        artifactBundle: seed.artifactBundle
    });
    return {
        seed,
        monitor,
        report,
        verdict: deriveRunVerdictView({
            distributedRun: seed.distributedRun,
            monitor,
            report,
            artifactBundle: seed.artifactBundle,
            refreshedAtEpochMs: seed.generatedAtEpochMs
        })
    };
}

function emptyRtcState(): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            runId: 'synthetic-control-run',
            agentId: 'local-browser',
            actor: 'local-browser',
            sessionId: 'local-session',
            roomId: 'seed-room',
            transport: 'realtime',
            control: {
                providerMode: 'browser-rallar'
            }
        },
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {}
    };
}

describe('synthetic distributed run seeds', () => {
    it('lists deterministic app-local seed metadata and normalizes seed ids', () => {
        expect(DISTRIBUTED_RUN_SEEDS.map((seed) => seed.id)).toEqual([
            'passed-clean',
            'passed-warnings',
            'failed-command',
            'high-latency-rtc',
            'artifact-missing'
        ]);

        expect(distributedRunSeedIdFromValue('failed-command')).toBe('failed-command');
        expect(distributedRunSeedIdFromValue('unknown')).toBeUndefined();

        const first = createSyntheticDistributedRunSeed('failed-command');
        const second = createSyntheticDistributedRunSeed('failed-command');

        expect(first).toEqual(second);
        expect(first.source).toBe('synthetic');
        expect(first.distributedRun.distributedRunId).toBe('seed-failed-command');
        expect(first.controlRun.runId).toBe('seed-control-failed-command');
        expect(first.artifactBundle?.distributedRunId).toBe('seed-failed-command');
    });

    it('writes artifact bundles the distributed run analysis reads without parse warnings', () => {
        const seeds = DISTRIBUTED_RUN_SEEDS
            .map((entry) => createSyntheticDistributedRunSeed(entry.id))
            .flatMap((seed) => seed.artifactBundle === undefined ? [] : [{ seed, bundle: seed.artifactBundle }]);

        expect(seeds.map(({ seed }) => seed.distributedRun.distributedRunId)).toEqual([
            'seed-passed-clean',
            'seed-passed-warnings',
            'seed-failed-command',
            'seed-high-latency-rtc'
        ]);
        for (const { seed, bundle } of seeds) {
            const analysis = computeDistributedRunArtifactAnalysis({
                files: bundle.files,
                generatedAtEpochMs: seed.generatedAtEpochMs
            });
            expect(analysis.left, seed.distributedRun.distributedRunId).toBeUndefined();
            expect(analysis.right?.analysis.parseWarnings, seed.distributedRun.distributedRunId).toEqual([]);
            expect(JSON.parse(bundle.files['failures.json'] ?? ''), seed.distributedRun.distributedRunId).toEqual({
                failures: seed.distributedRun.rollup.failures
            });
        }
    });

    it('derives a clean passed verdict from the passed-clean seed', () => {
        const { verdict, monitor } = verdictFor('passed-clean');

        expect(verdict).toMatchObject({
            title: 'Outcome passed',
            verdict: 'passed',
            tone: 'good',
            artifactStatus: 'valid'
        });
        expect(verdict.warningSignals).toEqual([]);
        expect(monitor.artifact.status).toBe('valid');
    });

    it('derives pass-with-review wording from evidence warning seeds', () => {
        const { verdict, seed, monitor } = verdictFor('passed-warnings');
        const diagnostic = seed.controlRun.events.find((event) => event.kind === 'diagnostic');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.browser.realtime.synthetic_seed',
            topic: 'rallar.browser.realtime.synthetic_seed',
            severity: 'warning',
            transport: 'messages.rtc',
            message: 'Synthetic RTC evidence includes a warning diagnostic.',
            source: 'distributed-run-seed'
        });
        expect(monitor.runtimeDiagnostics).toHaveLength(1);

        expect(verdict).toMatchObject({
            title: 'Outcome passed; evidence needs review',
            verdict: 'passed',
            tone: 'warn'
        });
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning');
    });

    it('derives a failed verdict with the real first command failure as likely cause', () => {
        const { verdict } = verdictFor('failed-command');

        expect(verdict).toMatchObject({
            title: 'Outcome failed',
            verdict: 'failed',
            tone: 'bad',
            likelyCause: 'Receiver did not observe the RTC payload.'
        });
        expect(verdict.causalTrail).toContainEqual(expect.objectContaining({
            kind: 'command-result',
            commandId: 'seed-start-receiver',
            agentId: 'seed-agent-b',
            targetKind: 'command',
            targetId: 'seed-start-receiver'
        }));
    });

    it('treats missing artifact evidence as a warning, not the run outcome', () => {
        const { verdict } = verdictFor('artifact-missing');

        expect(verdict).toMatchObject({
            title: 'Outcome passed; evidence needs review',
            verdict: 'passed',
            tone: 'warn',
            artifactStatus: 'not-loaded'
        });
        expect(verdict.warningSignals.join(' ')).toContain('Evidence warning: artifact not loaded');
    });

    it('feeds high-latency distributed agents into RTC performance charts', () => {
        const { monitor } = verdictFor('high-latency-rtc');
        const state = emptyRtcState();
        const performance = computeRtcPerformanceView({
            diagnostics: computeRtcDiagnostics(state, DIAGNOSTICS_NOW_EPOCH_MS),
            state,
            distributedMonitor: monitor,
            histogramBucketCount: 4
        });

        expect(performance.scatter.map((point) => [point.commandId, point.source, point.agentId])).toEqual([
            ['seed-agent-a', 'distributed-agent', 'seed-agent-a'],
            ['seed-agent-b', 'distributed-agent', 'seed-agent-b'],
            ['seed-agent-c', 'distributed-agent', 'seed-agent-c']
        ]);
        expect(performance.histogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
        expect(performance.summary.p95Ms).toBeGreaterThanOrEqual(900);
        expect(performance.agentMatrix.map((cell) => [cell.laneId, cell.metric])).toEqual(expect.arrayContaining([
            ['seed-agent-a', 'expected'],
            ['seed-agent-b', 'active'],
            ['seed-agent-c', 'observed']
        ]));
    });
});
