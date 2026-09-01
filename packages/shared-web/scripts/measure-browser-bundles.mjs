import { execFileSync } from 'node:child_process';
// dprint-ignore
import {
    existsSync,
    mkdirSync,
    readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// dprint-ignore
import {
    brotliCompressSync,
    constants,
    gzipSync
} from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const outputDir = path.join(tmpdir(), 'rallar-shared-web-bundles');
const checkMode = process.argv.includes('--check');
const esbuildBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
);

const entries = [
    {
        label: 'browser/rallar.ts',
        entry: 'packages/shared-web/browser/rallar.ts',
        output: 'rallar-browser-facade.min.js',
        brotliBudgetKiB: 165
    },
    {
        label: 'browser/rallar-core.ts',
        entry: 'packages/shared-web/browser/rallar-core.ts',
        output: 'rallar-browser-core.min.js',
        brotliBudgetKiB: 100
    },
    {
        label: 'browser/rallar-realtime.ts',
        entry: 'packages/shared-web/browser/rallar-realtime.ts',
        output: 'rallar-browser-realtime.min.js',
        brotliBudgetKiB: 100
    },
    {
        label: 'browser/rallar-data.ts',
        entry: 'packages/shared-web/browser/rallar-data.ts',
        output: 'rallar-browser-data.min.js',
        brotliBudgetKiB: 20
    },
    {
        label: 'browser/rallar-crdt.ts',
        entry: 'packages/shared-web/browser/rallar-crdt.ts',
        output: 'rallar-browser-crdt.min.js',
        brotliBudgetKiB: 30
    },
    {
        label: 'browser/rallar-media-calls.ts',
        entry: 'packages/shared-web/browser/rallar-media-calls.ts',
        output: 'rallar-browser-media-calls.min.js',
        brotliBudgetKiB: 10
    },
    {
        label: 'shared-web/mod.ts',
        entry: 'packages/shared-web/mod.ts',
        output: 'rallar-shared-web-mod.min.js'
    }
];

if (!existsSync(esbuildBin)) {
    throw new Error(`Missing esbuild binary at ${esbuildBin}`);
}

mkdirSync(outputDir, { recursive: true });

const results = entries.map((entry) => measureEntry(entry));

console.log('Rallar shared-web browser bundle sizes');
console.log('');
console.log('| Entry | Minified | Gzip | Brotli | Budget | Status | Output |');
console.log('|---|---:|---:|---:|---:|---|---|');
for (const result of results) {
    console.log(
        `| ${result.label} | ${formatKiB(result.minifiedBytes)} | ${formatKiB(result.gzipBytes)} | ${
            formatKiB(result.brotliBytes)
        } | ${formatBudget(result.brotliBudgetBytes)} | ${toBudgetStatus(result)} | ${result.outputPath} |`
    );
}
console.log('');
if (checkMode) {
    const failures = results.filter((result) => result.isOverBudget);
    if (failures.length > 0) {
        console.error(
            `Bundle budget check failed for ${failures.map((result) => result.label).join(', ')}.`
        );
        process.exitCode = 1;
    }
    else {
        console.log('Bundle budget check passed.');
    }
}
else {
    console.log('These are reporting-only measurements; run with --check to enforce budgets.');
}

function measureEntry(entry) {
    const outputPath = path.join(outputDir, entry.output);
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
            `--outfile=${outputPath}`
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
    const brotliBudgetBytes = toBudgetBytes(entry.brotliBudgetKiB);
    return {
        label: entry.label,
        outputPath,
        minifiedBytes: bytes.length,
        gzipBytes: gzipSync(bytes, { level: 9 }).length,
        brotliBytes,
        brotliBudgetBytes,
        isOverBudget: brotliBudgetBytes !== undefined &&
            brotliBytes >= brotliBudgetBytes
    };
}

function formatKiB(bytes) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatBudget(bytes) {
    return bytes === undefined ? '-' : `< ${formatKiB(bytes)}`;
}

function toBudgetStatus(result) {
    if (result.brotliBudgetBytes === undefined) {
        return '-';
    }

    return result.isOverBudget ? 'over' : 'ok';
}

function toBudgetBytes(kib) {
    return kib === undefined ? undefined : kib * 1024;
}
