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
                'apps/rallar-black-box/src/app.tsx',
                'apps/rallar-black-box/src/control-run-manager/',
                'apps/rallar-black-box/src/distributed-recipes.ts',
                'apps/rallar-black-box/src/rtc-diagnostics.ts',
                'apps/rallar-black-box/src/topology-graph.ts',
                'apps/rallar-black-box/src/flow-builder',
                'apps/rallar-black-box/src/schema-authoring.ts',
                'packages/shared-test/rallar-bb-test/schema.ts',
                'packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts',
                'packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts'
            ]
        ) {
            expect(inputs, `headless bundle should not include ${forbidden}`).not.toContainEqual(
                expect.stringContaining(forbidden)
            );
        }

        // The control-command validator reads its field tables from the canonical command-field
        // definition, so neither the JSON schema nor the capability catalog ships to the agent.
        // The v2 acknowledgement, the receipt control, one relayed ACK per logical recipient, and
        // the send-time QoS request check with the messages.send qos passthrough measure
        // 275.1064453125 KiB with this exact harness. The next whole-KiB ceiling is 276; all
        // operator dependency exclusions above remain enforced.
        expect(result.brotliKiB).toBeLessThan(276);
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
