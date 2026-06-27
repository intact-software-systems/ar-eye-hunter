import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

describe('distributed artifact SPA reuse', () => {
    it('exposes imported CI artifact analysis in the Runs panel', () => {
        const source = readFileSync(
            path.join(repoRoot, 'apps/rallar-black-box/src/App.tsx'),
            'utf8',
        );

        expect(source).toContain('analyzeDistributedRunArtifactFiles');
        expect(source).toContain('distributedArtifactBundleFromFiles');
        expect(source).toContain('Imported CI artifact analysis');
        expect(source).toContain('handleDistributedArtifactFiles');
        expect(source).toContain('type="file"');
        expect(source).toContain('accept=".json,.jsonl,application/json"');
        expect(source).toContain('webkitdirectory');
        expect(source).toContain('Required files');
        expect(source).toContain('Selected files');
        expect(source).toContain('Evidence Quality');
        expect(source).toContain('Performance Health');
        expect(source).toContain('P50 command');
        expect(source).toContain('P95 command');
        expect(source).toContain('P99 command');
        expect(source).toContain('Outliers');
        expect(source).toContain('Stream frames');
        expect(source).toContain('P50 stream');
        expect(source).toContain('P95 stream');
        expect(source).toContain('P99 stream');
        expect(source).toContain('Stream drops');
        expect(source).toContain('Backpressure');
        expect(source).toContain('Achieved Hz');
        expect(source).toContain('Slowest stream agent');
        expect(source).toContain('Slowest agent');
    });
});
