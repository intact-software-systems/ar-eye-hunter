import { describe, expect, it } from 'vitest';

import { decodeGrowthRun } from '../../../shared-test/rallar-bb-test/alm/growth-proof/decode-growth-run.ts';
import {
    GROWTH_SURFACES,
    GROWTH_SURVEY_SURFACE_IDS
} from '../../../shared-test/rallar-bb-test/alm/growth-proof/growth-surfaces.ts';
import { computeGrowthVerdict } from '../../../shared-test/rallar-bb-test/alm/growth-proof/growth-verdict.ts';
import { toGrowthVerdictMarkdown } from '../../../shared-test/rallar-bb-test/alm/growth-proof/to-growth-verdict-markdown.ts';

const WINDOW_STARTED_AT_EPOCH_MS = 1_800_000_000_000;

function toCensusEnvelope(agentId: string, minutes: number): object {
    const atEpochMs = WINDOW_STARTED_AT_EPOCH_MS + minutes * 60_000;
    const pageHeap = { usedJSHeapSize: 40_000_000, totalJSHeapSize: 50_000_000, jsHeapSizeLimit: 4_000_000_000, forcedGc: true };
    return { kind: 'stats', agentId, atEpochMs, payload: { kind: 'stats', atEpochMs, payload: { atEpochMs, browser: { pageHeap } } } };
}

describe('Growth verdict after an early failure', () => {
    it('writes a failing verdict document, not an error, when the runner failed at minute 2 and every page reading predates the warm-up', () => {
        const runJson = JSON.stringify({
            windowStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS,
            workload: {
                runner: 'failed',
                manifestStartedAtEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 20_000,
                manifestCompletedAtEpochMs: null,
                manifestAgents: 15,
                eventHistoryMaxEvents: 10_000,
                groupCurrentSnapshotCacheMaxEntries: 32,
                apiProcesses: 3,
                churnStarted: 1,
                churnPassed: 0,
                churnFailedRunIds: []
            }
        });
        const poll = JSON.stringify({
            atEpochMs: WINDOW_STARTED_AT_EPOCH_MS + 120_000,
            value: { stats: [toCensusEnvelope('controller-01', 1), toCensusEnvelope('controller-02', 2)], events: [] }
        });
        const decoded = decodeGrowthRun({
            runJson,
            postgres: '',
            adminSystem: '',
            adminQueues: '',
            adminRealtime: '',
            processRss: '',
            controlRun: poll,
            apiHeap: ''
        }).right!;

        const verdict = computeGrowthVerdict({
            surveyedSurfaceIds: GROWTH_SURVEY_SURFACE_IDS,
            surfaces: GROWTH_SURFACES,
            run: decoded.run,
            samples: decoded.samples
        });
        const markdown = toGrowthVerdictMarkdown({ verdict, skippedLines: decoded.skippedLines });

        expect(verdict.passed).toBe(false);
        expect(markdown).toContain('**FAIL**');
        expect(verdict.rows.filter((row) => row.reader.includes('pageHeap')).map((row) => row.outcome)).toContain('insufficient');
    });
});
