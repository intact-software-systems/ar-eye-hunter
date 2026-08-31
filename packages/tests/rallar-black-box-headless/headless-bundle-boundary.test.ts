import { buildSync, type Metafile } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

interface HeadlessBundleMeasurement {
    readonly brotliKiB: number;
    readonly metafile: Metafile;
}

const repoRoot = process.cwd();
const outputDir = path.join(tmpdir(), 'rallar-black-box-headless-boundary-test');

describe('rallar-black-box-headless bundle boundary', () => {
    it('excludes operator UI dependencies and surfaces', () => {
        const result = bundleHeadlessEntry();
        const inputs = Object.keys(result.metafile.inputs);

        for (
            const forbidden of [
                'node_modules/react',
                'node_modules/react-dom',
                'node_modules/sigma',
                'node_modules/graphology',
                'apps/rallar-black-box/src/App.tsx',
                'apps/rallar-black-box/src/control-run-manager.ts',
                'apps/rallar-black-box/src/distributed-recipes.ts',
                'apps/rallar-black-box/src/rtc-diagnostics.ts',
                'apps/rallar-black-box/src/topology-graph.ts',
                'apps/rallar-black-box/src/flow-builder.ts',
                'apps/rallar-black-box/src/schema-authoring.ts'
            ]
        ) {
            expect(inputs, `headless bundle should not include ${forbidden}`).not.toContainEqual(
                expect.stringContaining(forbidden)
            );
        }

        // Validated snapshot point reads and race-fenced repair add a bounded browser cost.
        // Group-formation Phase 1 (overlay provenance admission, bounded bootstrap
        // selection, outbound dial plan) adds ~0.7 KiB; measured 194.61 at that change.
        // Phase 3 M2 browser delta consumption (delta-envelope wire validation,
        // snapshot materialization, floored gap pull) adds ~1.9 KiB; measured
        // 200.40 at that change.
        // Strict AppInbox mutation paths and canonical failure decoding add
        // ~0.87 KiB over the stacked base; measured 202.42 at that change.
        // Slice 8a's two-role overlay caches, validated HTTP hydration, and
        // lifecycle race fences add 0.771484 KiB over the Slice 7 base after
        // removing the dead browser graph-to-overlay mutation path:
        // 202.944336 KiB -> 203.715820 KiB.
        // One deadline across room refresh and best-effort topology hydration
        // adds 0.284180 KiB: 203.715820 KiB -> 204.000000 KiB.
        expect(result.brotliKiB).toBeLessThan(205);
    });
});

function bundleHeadlessEntry(): HeadlessBundleMeasurement {
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'headless-agent.boundary.min.js');
    const result = buildSync({
        absWorkingDir: repoRoot,
        entryPoints: ['apps/rallar-black-box-headless/src/main.ts'],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2023',
        tsconfig: 'apps/rallar-black-box-headless/tsconfig.json',
        outfile: outputPath,
        metafile: true
    });

    const bytes = readFileSync(outputPath);
    const brotliBytes = brotliCompressSync(bytes, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: 11
        }
    }).length;

    return {
        brotliKiB: brotliBytes / 1024,
        metafile: result.metafile
    };
}
