// @vitest-environment happy-dom
import type { DistributedRunPerformanceAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
    AnalyzeArtifactProjection,
    AnalyzeWorkerAnalysisProjection
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-projection-contract.ts';
import { AnalyzePerformance } from '../../../apps/rallar-black-box/src/recipe-console/analyze/AnalyzePerformance.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

const GENERATED_AT_EPOCH_MS = 1_700_000_000_000;

const ANALYSIS_SECTIONS = {
    generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
    artifactSchemaVersion: 1,
    distributedRunId: 'distributed-a',
    controlRunId: 'control-a',
    status: 'passed',
    summary: { agents: 1, passRate: 1, failureGroups: 0, blockingFailures: 0 },
    parseWarnings: []
} as const;

function performanceWithCommandTiming(
    commandTiming: DistributedRunPerformanceAnalysis['commandTiming']
): DistributedRunPerformanceAnalysis {
    return {
        agentCount: 1,
        passRate: 1,
        reconnectCount: 0,
        diagnosticCount: 0,
        warningDiagnosticCount: 0,
        errorDiagnosticCount: 0,
        exportedEventCount: 0,
        agentReportedEventCount: 0,
        failedAgentCount: 0,
        commandTiming,
        slowestAgents: []
    };
}

function fullAnalysis(
    performance?: DistributedRunPerformanceAnalysis
): AnalyzeWorkerAnalysisProjection {
    return {
        ...ANALYSIS_SECTIONS,
        detail: 'full',
        ok: true,
        summaryMarkdown: '# Summary',
        ...(performance ? { performance } : {})
    };
}

function boundedAnalysis(): AnalyzeWorkerAnalysisProjection {
    return { ...ANALYSIS_SECTIONS, detail: 'bounded', ok: true };
}

function artifactProjection(
    analysis: AnalyzeWorkerAnalysisProjection
): AnalyzeArtifactProjection {
    return {
        distributedRunId: 'distributed-a',
        controlRunId: 'control-a',
        identity: {
            distributedRunId: 'distributed-a',
            distributedRunIdExact: true,
            controlRunId: 'control-a',
            controlRunIdExact: true
        },
        workspace: {
            source: 'bundle-envelope',
            support: 'supported',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            inventory: [],
            issues: []
        },
        analysis,
        issueMarkdown: '',
        provenance: {
            source: 'control',
            label: 'Control artifact distributed-a',
            workspaceSource: 'bundle-envelope',
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            selectedFileCount: 1,
            artifactFileCount: 1,
            loadedFileCount: 1,
            ignoredFileCount: 0,
            workspaceIgnoredFileCount: 0,
            ignoredFiles: []
        }
    };
}

describe('AnalyzePerformance sample count', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        await act(async () => {
            root?.unmount();
        });
        root = undefined;
        container.remove();
    });

    async function renderSampleCount(
        analysis: AnalyzeWorkerAnalysisProjection
    ): Promise<string> {
        await act(async () => {
            root = createRoot(container);
            root.render(createElement(AnalyzePerformance, {
                model: artifactProjection(analysis)
            }));
        });
        return container.querySelector('header span')?.textContent ?? '';
    }

    it('reports a recorded zero-sample summary as zero command samples', async () => {
        expect(
            await renderSampleCount(
                fullAnalysis(performanceWithCommandTiming({ count: 0 }))
            )
        ).toBe('0 command samples');
    });

    it('reports a recorded sample count exactly', async () => {
        expect(
            await renderSampleCount(
                fullAnalysis(performanceWithCommandTiming({ count: 12, p50Ms: 4 }))
            )
        ).toBe('12 command samples');
    });

    it('reports a summary that omits its count as unknown, not as zero', async () => {
        expect(
            await renderSampleCount(
                fullAnalysis(performanceWithCommandTiming({ p50Ms: 4 }))
            )
        ).toBe('Command samples unknown');
    });

    it('reports a full analysis without a performance section as unknown, not as zero', async () => {
        expect(await renderSampleCount(fullAnalysis())).toBe('Command samples unknown');
    });

    it('reports a bounded projection as unknown, not as zero', async () => {
        expect(await renderSampleCount(boundedAnalysis())).toBe('Command samples unknown');
    });
});
