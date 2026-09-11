import {
    buildSync,
    type Metafile
} from 'esbuild';
import {
    mkdirSync,
    readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    brotliCompressSync,
    constants
} from 'node:zlib';
import {
    describe,
    expect,
    it
} from 'vitest';

interface HeadlessBundleMeasurement {
    readonly brotliKiB: number;
    readonly metafile: Metafile;
}

describe('rallar-black-box-headless bundle boundary', () => {
    it('excludes operator UI dependencies and surfaces', () => {
        const result = bundleHeadlessEntry(
            process.cwd(),
            path.join(tmpdir(), 'rallar-black-box-headless-boundary-test')
        );
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

        // The maintainer approved necessary ALM and formation-command growth.
        // Keep the smallest whole-KiB strict limit containing the measured
        // behavior, with all operator dependency exclusions intact.
        // Measured 252.87 KiB brotli after the inbound runtime composed on the generic work
        // handler (F2 Task 5); the limit was raised to the next whole KiB at 252.02 (R22/R24).
        // Measured 253.03 KiB brotli after wiring outbound admission diagnostics through the
        // browser composition and middleware (F2 Task 6b); the limit was raised to 254.
        // Measured 254.40 KiB brotli after adding the ALM storage schema identity and
        // delete-on-mismatch reset, including its black-box diagnostic relay (F2 Task 10); the
        // limit was raised to 255.
        // Main measured 252.37 KiB brotli for the RTC authority recovery and live
        // durable-admission observation (#554) against a 253 limit; merging both lines
        // measured 255.46 KiB, so the limit was raised to 256.
        // Measured 256.19 KiB brotli after splitting the outbound commit hold into its read and
        // write phases and attributing each commit to its origin; the limit was raised to 257.
        // Measured 257.34 KiB brotli after cutting the readiness scan volume and naming the hop
        // that drops an RTC offer (F2 Task 13 Step 4); the limit was raised to 258.
        // Main's canonical room readiness (#557) measures 253.10546875 KiB brotli on its own;
        // merging it with the ALM line measures 257.9580078125 KiB, so the 258 limit still holds.
        // Measured 258.2626953125 KiB brotli after the Task 13 fix round -- the engine's wake
        // listeners, the typed RTC signaling failure and its lifecycle forwarding; the limit was
        // raised to 259.
        // Measured 259.0634765625 KiB brotli after the Task 13 evidence round -- the named
        // room-authority denial, the outbound readiness probe and the inbound rotation's liveness
        // witness; the limit was raised to 260.
        // Measured 260.0009765625 KiB brotli after the F2b drain-latency instrumentation -- the
        // batch phase split, the per-claim `claim-settled` event and the relayed readiness probe;
        // the limit was raised to 261.
        expect(result.brotliKiB).toBeLessThan(261);
    });
});

function bundleHeadlessEntry(repoRoot: string, outputDir: string): HeadlessBundleMeasurement {
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
