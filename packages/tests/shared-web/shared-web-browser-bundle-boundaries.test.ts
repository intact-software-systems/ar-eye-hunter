import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';

type BundleBoundary = Readonly<{
    label: string;
    entry: string;
    output: string;
    brotliBudgetKiB: number;
}>;

type EsbuildMetafile = Readonly<{
    inputs: Readonly<Record<string, unknown>>;
}>;

const repoRoot = process.cwd();
const outputDir = path.join(tmpdir(), 'rallar-shared-web-boundary-test');
const esbuildBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
);

const budgetedEntries: readonly BundleBoundary[] = [
    {
        label: 'browser/rallar.ts',
        entry: 'packages/shared-web/browser/rallar.ts',
        output: 'rallar-browser-facade.boundary.min.js',
        brotliBudgetKiB: 161
    },
    {
        label: 'browser/rallar-core.ts',
        entry: 'packages/shared-web/browser/rallar-core.ts',
        output: 'rallar-browser-core.boundary.min.js',
        brotliBudgetKiB: 100
    },
    {
        label: 'browser/rallar-realtime.ts',
        entry: 'packages/shared-web/browser/rallar-realtime.ts',
        output: 'rallar-browser-realtime.boundary.min.js',
        brotliBudgetKiB: 100
    },
    {
        label: 'browser/rallar-data.ts',
        entry: 'packages/shared-web/browser/rallar-data.ts',
        output: 'rallar-browser-data.boundary.min.js',
        brotliBudgetKiB: 20
    },
    {
        label: 'browser/rallar-crdt.ts',
        entry: 'packages/shared-web/browser/rallar-crdt.ts',
        output: 'rallar-browser-crdt.boundary.min.js',
        brotliBudgetKiB: 30
    },
    {
        label: 'browser/rallar-media-calls.ts',
        entry: 'packages/shared-web/browser/rallar-media-calls.ts',
        output: 'rallar-browser-media-calls.boundary.min.js',
        brotliBudgetKiB: 10
    }
];

describe('shared-web browser bundle boundaries', () => {
    it('keeps shared-web from declaring graphology directly', () => {
        const manifest = JSON.parse(
            readFileSync(
                path.join(repoRoot, 'packages/shared-web/package.json'),
                'utf8'
            )
        ) as {
            dependencies?: Readonly<Record<string, string>>;
            devDependencies?: Readonly<Record<string, string>>;
            scripts?: Readonly<Record<string, string>>;
        };

        expect(manifest.dependencies ?? {}).not.toHaveProperty('graphology');
        expect(manifest.devDependencies ?? {}).not.toHaveProperty('graphology');
        expect(manifest.scripts?.['check:browser-bundles']).toBe(
            'node scripts/measure-browser-bundles.mjs --check'
        );
    });

    it('keeps narrow core and realtime entry points free of graph, Temporal polyfill, and full facade runtime imports', () => {
        const core = bundleForBoundary(budgetedEntries[1]);
        const realtime = bundleForBoundary(budgetedEntries[2]);

        for (const result of [core, realtime]) {
            const inputs = Object.keys(result.metafile.inputs);
            expect(inputs, `${result.label} should not include graphology`).not
                .toContainEqual(expect.stringContaining('node_modules/graphology'));
            expect(inputs, `${result.label} should not include Temporal polyfill`).not
                .toContainEqual(
                    expect.stringContaining('node_modules/@js-temporal/polyfill')
                );
            expect(inputs, `${result.label} should not include full rallar composer`).not
                .toContain('packages/shared-web/browser/rallar.ts');
        }
    });

    it('keeps measured browser entry points under their Brotli budgets', () => {
        for (const entry of budgetedEntries) {
            const result = bundleForBoundary(entry);

            expect(
                result.brotliKiB,
                `${entry.label} Brotli size`
            ).toBeLessThan(entry.brotliBudgetKiB);
        }
    });

    it('erases both type-only edges between room contracts and group-state translation', () => {
        const translation = bundleForBoundary({
            label: 'room group-state translation',
            entry: 'packages/shared-web/browser/rooms/room-group-state-translation.ts',
            output: 'room-group-state-translation.boundary.min.js',
            brotliBudgetKiB: 1
        });
        const contracts = bundleForBoundary({
            label: 'room contracts',
            entry: 'packages/shared-web/browser/rooms/rallar-room-contracts.ts',
            output: 'rallar-room-contracts.boundary.min.js',
            brotliBudgetKiB: 1
        });

        expect(Object.keys(translation.metafile.inputs)).not.toContain(
            'packages/shared-web/browser/rooms/rallar-room-contracts.ts'
        );
        expect(Object.keys(contracts.metafile.inputs)).not.toContain(
            'packages/shared-web/browser/rooms/room-group-state-translation.ts'
        );
    });
});

function bundleForBoundary(entry: BundleBoundary): Readonly<{
    label: string;
    brotliKiB: number;
    metafile: EsbuildMetafile;
}> {
    mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, entry.output);
    const metafilePath = `${outputPath}.meta.json`;

    execFileSync(
        esbuildBin,
        [
            entry.entry,
            '--bundle',
            '--minify',
            '--format=esm',
            '--platform=browser',
            '--target=es2022',
            '--tsconfig=packages/shared-web/tsconfig.json',
            `--outfile=${outputPath}`,
            `--metafile=${metafilePath}`
        ],
        {
            cwd: repoRoot,
            stdio: ['ignore', 'ignore', 'pipe']
        }
    );

    const bytes = readFileSync(outputPath);
    const brotliBytes = brotliCompressSync(bytes, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: 11
        }
    }).length;

    return {
        label: entry.label,
        brotliKiB: brotliBytes / 1024,
        metafile: JSON.parse(readFileSync(metafilePath, 'utf8')) as EsbuildMetafile
    };
}
