import { describe, expect, it } from 'vitest';
import { createDistributedRunArtifactDownload } from '../../../apps/rallar-black-box/src/recipe-console/control/distributed-run-artifact-download.ts';

describe('Recipe Console distributed artifact download', () => {
    it('preserves ordinary run IDs in deterministic filenames', () => {
        expect(createDistributedRunArtifactDownload({}, 'distributed-a').filename)
            .toBe('distributed-a-artifact.json');
    });

    it('bounds and sanitizes artifact-controlled filename segments', () => {
        const filename = createDistributedRunArtifactDownload(
            {},
            `../unsafe\u202E/${'x'.repeat(10_000)}`
        ).filename;

        expect(filename).toMatch(/-artifact\.json$/);
        expect(filename.length).toBeLessThanOrEqual(160);
        expect(filename).not.toMatch(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u);
        expect(filename).not.toContain('..');
    });

    it('removes lone surrogates without stripping valid paired Unicode', () => {
        const lone = JSON.parse('"dist-\\ud800-unsafe"') as string;
        const malformed = createDistributedRunArtifactDownload({}, lone).filename;
        const valid = createDistributedRunArtifactDownload({}, 'dist-🛰️').filename;

        expect(malformed).not.toMatch(/[\ud800-\udfff]/u);
        expect(valid).toBe('dist-🛰️-artifact.json');
    });
});
