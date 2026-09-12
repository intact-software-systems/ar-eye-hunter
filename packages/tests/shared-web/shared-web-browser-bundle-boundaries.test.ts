import { execFileSync } from 'node:child_process';
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

interface BundleBoundary {
    readonly label: string;
    readonly entry: string;
    readonly output: string;
    readonly brotliBudgetKiB: number;
}

interface EsbuildMetafile {
    readonly inputs: Readonly<Record<string, unknown>>;
}

interface SharedWebPackageManifest {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
}

interface BrowserBundleMeasurement {
    readonly label: string;
    readonly brotliKiB: number;
    readonly metafile: EsbuildMetafile;
}

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
        // Maintainer-approved ceiling: the measured payload is 207.16796875 KiB, so the strict
        // budget is 208 KiB.
        label: 'browser/rallar.ts',
        entry: 'packages/shared-web/browser/rallar.ts',
        output: 'rallar-browser-facade.boundary.min.js',
        brotliBudgetKiB: 208
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
    },
    {
        // Measured 1.69921875 KiB; types erase and the runtime surface is rallar-core.ts's own. The
        // budget starts tight so this entry can detect a regression rather than absorb one.
        label: 'browser/rallar-messages.ts',
        entry: 'packages/shared-web/browser/rallar-messages.ts',
        output: 'rallar-browser-messages.boundary.min.js',
        brotliBudgetKiB: 3
    }
];

describe('shared-web browser package boundary', () => {
    it('keeps shared-web from declaring graphology directly', () => {
        const manifest = toSharedWebPackageManifest(
            JSON.parse(
                readFileSync(
                    path.join(repoRoot, 'packages/shared-web/package.json'),
                    'utf8'
                )
            )
        );

        expect(manifest.dependencies ?? {}).not.toHaveProperty('graphology');
        expect(manifest.devDependencies ?? {}).not.toHaveProperty('graphology');
    });

    it('validates JSON envelopes before consuming manifest and metafile properties', () => {
        const manifest = toSharedWebPackageManifest({
            dependencies: { '@js-temporal/polyfill': '^0.5.1' }
        });
        expect(manifest.dependencies).toEqual({ '@js-temporal/polyfill': '^0.5.1' });
        expect(() => toSharedWebPackageManifest([])).toThrow(
            'shared-web package manifest must be an object'
        );
        expect(() => toSharedWebPackageManifest({ dependencies: [] })).toThrow(
            'shared-web package manifest.dependencies must be an object'
        );

        const metafile = toEsbuildMetafile({ inputs: { 'entry.ts': {} } });
        expect(Object.keys(metafile.inputs)).toEqual(['entry.ts']);
        expect(() => toEsbuildMetafile([])).toThrow(
            'esbuild metafile must be an object'
        );
        expect(() => toEsbuildMetafile({ inputs: null })).toThrow(
            'esbuild metafile inputs must be an object'
        );
    });
});

describe('shared-web browser bundle boundaries', () => {
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

function bundleForBoundary(entry: BundleBoundary): BrowserBundleMeasurement {
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
        metafile: toEsbuildMetafile(JSON.parse(readFileSync(metafilePath, 'utf8')))
    };
}

function toSharedWebPackageManifest(value: unknown): SharedWebPackageManifest {
    const manifest = toJsonObject(value, 'shared-web package manifest');
    return {
        dependencies: toOptionalStringRecord(manifest.dependencies, 'shared-web package manifest.dependencies'),
        devDependencies: toOptionalStringRecord(
            manifest.devDependencies,
            'shared-web package manifest.devDependencies'
        )
    };
}

function toEsbuildMetafile(value: unknown): EsbuildMetafile {
    const metafile = toJsonObject(value, 'esbuild metafile');
    return {
        inputs: toJsonObject(metafile.inputs, 'esbuild metafile inputs')
    };
}

function toOptionalStringRecord(
    value: unknown,
    label: string
): Readonly<Record<string, string>> | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = toJsonObject(value, label);
    const stringRecord: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record)) {
        if (typeof entry !== 'string') {
            throw new Error(`${label}.${key} must be a string`);
        }
        stringRecord[key] = entry;
    }
    return stringRecord;
}

function toJsonObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}
