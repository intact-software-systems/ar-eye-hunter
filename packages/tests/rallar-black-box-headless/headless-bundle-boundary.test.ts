import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';

type EsbuildMetafile = Readonly<{
    inputs: Readonly<Record<string, unknown>>;
}>;

const repoRoot = process.cwd();
const outputDir = path.join(tmpdir(), 'rallar-black-box-headless-boundary-test');
const esbuildBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
);

describe('rallar-black-box-headless bundle boundary', () => {
    it('excludes operator UI dependencies and surfaces', () => {
        const result = bundleHeadlessEntry();
        const inputs = Object.keys(result.metafile.inputs);

        for (const forbidden of [
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
            'apps/rallar-black-box/src/schema-authoring.ts',
        ]) {
            expect(
                inputs,
                `headless bundle should not include ${forbidden}`,
            ).not.toContainEqual(expect.stringContaining(forbidden));
        }

        expect(result.brotliKiB).toBeLessThan(190);
    });
});

function bundleHeadlessEntry(): Readonly<{
    brotliKiB: number;
    metafile: EsbuildMetafile;
}> {
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'headless-agent.boundary.min.js');
    const metafilePath = `${outputPath}.meta.json`;

    execFileSync(
        esbuildBin,
        [
            'apps/rallar-black-box-headless/src/main.ts',
            '--bundle',
            '--minify',
            '--format=esm',
            '--platform=browser',
            '--target=es2023',
            '--tsconfig=apps/rallar-black-box-headless/tsconfig.json',
            `--outfile=${outputPath}`,
            `--metafile=${metafilePath}`,
        ],
        {
            cwd: repoRoot,
            stdio: ['ignore', 'ignore', 'pipe'],
        },
    );

    const bytes = readFileSync(outputPath);
    const brotliBytes = brotliCompressSync(bytes, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
        },
    }).length;

    return {
        brotliKiB: brotliBytes / 1024,
        metafile: JSON.parse(readFileSync(metafilePath, 'utf8')) as EsbuildMetafile,
    };
}
