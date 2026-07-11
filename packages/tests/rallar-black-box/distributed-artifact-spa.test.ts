import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

describe('distributed artifact SPA reuse', () => {
    it('exposes imported CI artifact analysis in the Runs panel', () => {
        const runsControllerSource = readFileSync(
            path.join(
                repoRoot,
                'apps/rallar-black-box/src/legacy/runner/runs/use-runner-runs-controller.ts',
            ),
            'utf8',
        );
        const distributedAnalysisSource = readFileSync(
            path.join(
                repoRoot,
                'apps/rallar-black-box/src/legacy/runner/runs/RunnerDistributedAnalysisSection.tsx',
            ),
            'utf8',
        );
        const distributedRecipeCatalogSource = readFileSync(
            path.join(
                repoRoot,
                'apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-recipe-catalog.ts',
            ),
            'utf8',
        );
        const importedAnalysisPath = path.join(
            repoRoot,
            'apps/rallar-black-box/src/legacy/runner/runs/ImportedDistributedArtifactAnalysisPanel.tsx',
        );

        expect(
            existsSync(importedAnalysisPath),
            'ImportedDistributedArtifactAnalysisPanel.tsx owner',
        ).toBe(true);
        if (!existsSync(importedAnalysisPath)) {
            return;
        }

        const importedAnalysisSource = readFileSync(importedAnalysisPath, 'utf8');
        const causalTrailSource = readFileSync(
            path.join(
                repoRoot,
                'apps/rallar-black-box/src/legacy/runner/evidence/CausalTrailPanel.tsx',
            ),
            'utf8',
        );
        const statusPresentationSource = readFileSync(
            path.join(
                repoRoot,
                'apps/rallar-black-box/src/legacy/runner/distributed/status-presentation.ts',
            ),
            'utf8',
        );

        expect(runsControllerSource).toContain('analyzeDistributedRunArtifactFiles');
        expect(runsControllerSource).toContain('distributedArtifactBundleFromFiles');
        expect(importedAnalysisSource).toContain('Imported CI artifact analysis');
        expect(runsControllerSource).toContain('handleDistributedArtifactFiles');
        expect(distributedRecipeCatalogSource).toContain('RTC Realtime Stability');
        expect(distributedRecipeCatalogSource).toContain('rtc-realtime-stability');
        expect(distributedAnalysisSource).toContain('type="file"');
        expect(distributedAnalysisSource).toContain(
            'accept=".json,.jsonl,application/json"',
        );
        expect(distributedAnalysisSource).toContain('webkitdirectory');
        expect(importedAnalysisSource).toContain('Required files');
        expect(importedAnalysisSource).toContain('Selected files');
        expect(importedAnalysisSource).toContain('Evidence Quality');
        expect(importedAnalysisSource).toContain('Performance Health');
        expect(causalTrailSource).toContain('Causal Trail');
        expect(statusPresentationSource).toContain('rtc-stream-performance');
        expect(importedAnalysisSource).toContain('Frame disposition');
        expect(importedAnalysisSource).toContain('P50 command');
        expect(importedAnalysisSource).toContain('P95 command');
        expect(importedAnalysisSource).toContain('P99 command');
        expect(importedAnalysisSource).toContain('Outliers');
        expect(importedAnalysisSource).toContain('Stream frames');
        expect(importedAnalysisSource).toContain('P50 stream');
        expect(importedAnalysisSource).toContain('P95 stream');
        expect(importedAnalysisSource).toContain('P99 stream');
        expect(importedAnalysisSource).toContain('Stream drops');
        expect(importedAnalysisSource).toContain('In-flight drops');
        expect(importedAnalysisSource).toContain('Max drift');
        expect(importedAnalysisSource).toContain('Late frames');
        expect(importedAnalysisSource).toContain('Backpressure');
        expect(importedAnalysisSource).toContain('Achieved Hz');
        expect(importedAnalysisSource).toContain('Slowest stream agent');
        expect(importedAnalysisSource).toContain('Slowest agent');
    });
});
