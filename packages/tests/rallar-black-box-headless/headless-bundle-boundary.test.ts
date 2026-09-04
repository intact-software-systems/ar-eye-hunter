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

        // The room-authority closure measures 208.4658203125 KiB with the
        // reviewed exclusions and build settings. Canonical inbound persistence,
        // durable local delivery, and fail-closed corruption handling measure
        // 215.4443359375 KiB. Reporting each peer setup's phases and bounding a
        // group's in-flight setups measures 216.6953125 KiB: the headless agent
        // runs the outbound dialing owner, the in-flight dial admission and the
        // member-policy validators itself. Persistence-ready IndexedDB writes
        // measure 218.9267578125 KiB. The maintainer approved the smallest
        // whole-KiB strict limit containing the current behavior.
        expect(result.brotliKiB).toBeLessThan(219);
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
