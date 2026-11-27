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

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

interface BundleBoundary {
    readonly label: string;
    readonly entry: string;
    readonly output: string;
    readonly brotliBudgetKiB: number;
}

interface EsbuildMetafile {
    readonly inputs: Readonly<Record<string, ApiJsonValue>>;
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

// The budget test bundles and compresses every budgeted entry with esbuild; on a loaded CI runner that takes longer than
// Vitest's 5 s default.
const BUNDLE_BUDGET_TEST_TIMEOUT_MS = 60_000;

const repoRoot = process.cwd();
const outputDir = path.join(tmpdir(), 'rallar-shared-web-boundary-test');
const esbuildBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
);

const budgetsKiB: Readonly<Record<string, number>> = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/shared-web/bundle-budgets.json'), 'utf8')
);

function budgetFor(label: string): number {
    const budget = budgetsKiB[label];
    if (budget === undefined) {
        throw new Error(`packages/shared-web/bundle-budgets.json has no budget for ${label}`);
    }
    return budget;
}

const budgetedEntries: readonly BundleBoundary[] = [
    {
        label: 'browser/rallar.ts',
        entry: 'packages/shared-web/browser/rallar.ts',
        output: 'rallar-browser-facade.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar.ts')
    },
    {
        label: 'browser/rallar-core.ts',
        entry: 'packages/shared-web/browser/rallar-core.ts',
        output: 'rallar-browser-core.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-core.ts')
    },
    {
        label: 'browser/rallar-realtime.ts',
        entry: 'packages/shared-web/browser/rallar-realtime.ts',
        output: 'rallar-browser-realtime.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-realtime.ts')
    },
    {
        label: 'browser/rallar-data.ts',
        entry: 'packages/shared-web/browser/rallar-data.ts',
        output: 'rallar-browser-data.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-data.ts')
    },
    {
        label: 'browser/rallar-crdt.ts',
        entry: 'packages/shared-web/browser/rallar-crdt.ts',
        output: 'rallar-browser-crdt.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-crdt.ts')
    },
    {
        label: 'browser/rallar-media-calls.ts',
        entry: 'packages/shared-web/browser/rallar-media-calls.ts',
        output: 'rallar-browser-media-calls.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-media-calls.ts')
    },
    {
        label: 'browser/rooms/events/court-ready-notifications.ts',
        entry: 'packages/shared-web/browser/rooms/events/court-ready-notifications.ts',
        output: 'court-ready-notifications.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/events/court-ready-notifications.ts')
    },
    {
        label: 'browser/rooms/events/court-alert-click.ts',
        entry: 'packages/shared-web/browser/rooms/events/court-alert-click.ts',
        output: 'court-alert-click.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/events/court-alert-click.ts')
    },
    {
        label: 'browser/rooms/events/court-alert-notification.ts',
        entry: 'packages/shared-web/browser/rooms/events/court-alert-notification.ts',
        output: 'court-alert-notification.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/events/court-alert-notification.ts')
    },
    {
        label: 'browser/rooms/events/rallar-room-event.ts',
        entry: 'packages/shared-web/browser/rooms/events/rallar-room-event.ts',
        output: 'rallar-room-event.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/events/rallar-room-event.ts')
    },
    {
        label: 'browser/rooms/entry/temporary-room-creation.ts',
        entry: 'packages/shared-web/browser/rooms/entry/temporary-room-creation.ts',
        output: 'temporary-room-creation.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/entry/temporary-room-creation.ts')
    },
    {
        label: 'browser/rooms/lobby/rallar-room-lobby.ts',
        entry: 'packages/shared-web/browser/rooms/lobby/rallar-room-lobby.ts',
        output: 'rallar-room-lobby.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/lobby/rallar-room-lobby.ts')
    },
    {
        label: 'browser/rooms/move/rallar-room-move.ts',
        entry: 'packages/shared-web/browser/rooms/move/rallar-room-move.ts',
        output: 'rallar-room-move.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/move/rallar-room-move.ts')
    },
    {
        label: 'browser/rooms/directory/rallar-room-directory.ts',
        entry: 'packages/shared-web/browser/rooms/directory/rallar-room-directory.ts',
        output: 'rallar-room-directory.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/directory/rallar-room-directory.ts')
    },
    {
        label: 'browser/rooms/entry/rallar-room-entry.ts',
        entry: 'packages/shared-web/browser/rooms/entry/rallar-room-entry.ts',
        output: 'rallar-room-entry.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/entry/rallar-room-entry.ts')
    },
    {
        label: 'browser/rooms/recent-rooms/rallar-recent-rooms.ts',
        entry: 'packages/shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts',
        output: 'rallar-recent-rooms.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rooms/recent-rooms/rallar-recent-rooms.ts')
    },
    {
        // This public entry point contains types only.
        label: 'browser/rallar-messages.ts',
        entry: 'packages/shared-web/browser/rallar-messages.ts',
        output: 'rallar-browser-messages.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/rallar-messages.ts')
    },
    {
        label: 'browser/parties/rallar-party.ts',
        entry: 'packages/shared-web/browser/parties/rallar-party.ts',
        output: 'rallar-party.boundary.min.js',
        brotliBudgetKiB: budgetFor('browser/parties/rallar-party.ts')
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

    it.each([
        'browser/rooms/events/court-ready-notifications.ts',
        'browser/rooms/events/court-alert-click.ts',
        'browser/rooms/events/court-alert-notification.ts',
        'browser/rooms/events/rallar-room-event.ts',
        'browser/rooms/entry/temporary-room-creation.ts',
        'browser/rooms/lobby/rallar-room-lobby.ts',
        'browser/parties/rallar-party.ts',
        'browser/rooms/move/rallar-room-move.ts',
        'browser/rooms/entry/rallar-room-entry.ts',
        'browser/rooms/recent-rooms/rallar-recent-rooms.ts',
        'browser/rooms/directory/rallar-room-directory.ts'
    ])(
        'limits %s to its room feature and required browser storage',
        (label) => {
            const entry = budgetedEntries.find((boundary) => boundary.label === label);
            if (!entry) {
                throw new Error('Missing room-entry bundle boundary');
            }
            const inputs = Object.keys(bundleForBoundary(entry).metafile.inputs);
            expect(inputs).not.toContain('packages/shared-web/browser/rallar.ts');
            expect(inputs).not.toContainEqual(expect.stringContaining('packages/shared-server/'));
            expect(inputs).not.toContainEqual(expect.stringContaining('node_modules/react/'));
            expect(inputs).not.toContainEqual(expect.stringContaining('node_modules/@js-temporal/polyfill'));
            const hasPrivateRecovery = label === 'browser/rooms/events/rallar-room-event.ts' ||
                label === 'browser/rooms/entry/temporary-room-creation.ts';
            const credentialStore = 'packages/shared-web/browser/auth/browser-credential-store.ts';
            expect(inputs.includes(credentialStore)).toBe(hasPrivateRecovery);
            expect(inputs.filter(path => path.includes('indexed-db')).sort()).toEqual(hasPrivateRecovery
                ? ['packages/shared/persistence/indexed-db-request.ts', 'packages/shared/persistence/open-indexed-db.ts']
                : []);
        }
    );

    // The receipt record is server state: no browser entry may bundle it.
    it.each(budgetedEntries)('keeps the receipt record out of $label', (entry) => {
        const inputs = Object.keys(bundleForBoundary(entry).metafile.inputs);
        expect(inputs).not.toContainEqual(expect.stringContaining('packages/shared/alm/receipt-record/'));
    });

    it('keeps measured browser entry points under their Brotli budgets', () => {
        for (const entry of budgetedEntries) {
            const result = bundleForBoundary(entry);

            expect(
                result.brotliKiB,
                `${entry.label} measures ${result.brotliKiB.toFixed(3)} KiB against ${entry.brotliBudgetKiB} in ` +
                    `packages/shared-web/bundle-budgets.json; budgets are adjustable, so raise it to ${Math.floor(result.brotliKiB) + 1} and say so in the PR`
            ).toBeLessThan(entry.brotliBudgetKiB);
        }
    }, BUNDLE_BUDGET_TEST_TIMEOUT_MS);

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

function toSharedWebPackageManifest(value: ApiJsonValue): SharedWebPackageManifest {
    const manifest = toJsonObject(value, 'shared-web package manifest');
    return {
        dependencies: toOptionalStringRecord(manifest.dependencies, 'shared-web package manifest.dependencies'),
        devDependencies: toOptionalStringRecord(
            manifest.devDependencies,
            'shared-web package manifest.devDependencies'
        )
    };
}

function toEsbuildMetafile(value: ApiJsonValue): EsbuildMetafile {
    const metafile = toJsonObject(value, 'esbuild metafile');
    return {
        inputs: toJsonObject(metafile.inputs, 'esbuild metafile inputs')
    };
}

function toOptionalStringRecord(
    value: ApiJsonValue | undefined,
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

function toJsonObject(value: ApiJsonValue, label: string): Readonly<Record<string, ApiJsonValue>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Readonly<Record<string, ApiJsonValue>>;
}
