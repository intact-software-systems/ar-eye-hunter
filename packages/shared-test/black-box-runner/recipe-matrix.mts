import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

import {
    blackBoxRunnerLivePreflightSkipReasons,
    runBlackBoxRunnerLivePreflight,
    shouldRunBlackBoxRunnerLivePreflight,
    type BlackBoxRunnerLivePreflightMatrixRequirement,
    type BlackBoxRunnerLivePreflightReport
} from './preflight/live-preflight.ts';
import {
    parseRecipeMatrixShard,
    resolveRecipeMatrixShard,
    type RecipeMatrixShard,
    type RecipeShardWeights
} from './recipe-matrix/resolve-recipe-matrix-shard.mts';

type MatrixMode = 'dry-run' | 'run';

type MatrixEntry = {
    id: string;
    recipe: string;
    category: string;
    mode: MatrixMode;
    profiles: string[];
    expectedExitCode: number;
    artifactName?: string;
    env?: Record<string, string>;
    requires?: BlackBoxRunnerLivePreflightMatrixRequirement;
    description?: string;
};

type MatrixFile = {
    version: number;
    description?: string;
    entries: MatrixEntry[];
};

type CliOptions = {
    profile: string;
    artifactDir?: string;
    ids: string[];
    list: boolean;
    requireGates: boolean;
    failFast: boolean;
    preflightOnly: boolean;
    verbose: boolean;
    help: boolean;
    shard?: RecipeMatrixShard;
};

type MatrixPreflightSummary = {
    ok: boolean;
    reportPath?: string;
    summary: BlackBoxRunnerLivePreflightReport['summary'];
    issueCodes: string[];
    skipReasons: readonly string[];
};

type SkippedMatrixRun = {
    id: string;
    recipe: string;
    status: 'SKIPPED';
    reasons: string[];
    preflight?: MatrixPreflightSummary;
};

type ExecutedMatrixRun = {
    id: string;
    recipe: string;
    status: 'PASSED' | 'FAILED';
    expectedExitCode: number;
    code: number;
    durationMs: number;
    artifactDir?: string;
    summary?: any;
    stdout?: string;
    stderr?: string;
    preflight?: MatrixPreflightSummary;
};

type MatrixRun = SkippedMatrixRun | ExecutedMatrixRun;

const SCRIPT_DIR = new URL('.', import.meta.url);
const REPO_ROOT = new URL('../../../', SCRIPT_DIR);
const MATRIX_FILE = new URL('./recipe-matrix.json', SCRIPT_DIR);
const SHARD_WEIGHTS_FILE = new URL('./recipe-matrix/recipe-shard-weights.json', SCRIPT_DIR);
const SCENARIO_CLI = new URL('./scenario-black-box.ts', SCRIPT_DIR);
const OFFLINE_VALIDATION_PROFILE = 'validation';

function usage(): string {
    return [
        'Usage:',
        '  bun run packages/shared-test/black-box-runner/recipe-matrix.mts [options]',
        '',
        'Options:',
        '  --profile=<name>              quick, dry, deterministic, validation, soak, traffic, parallel, failure-diagnostics, live, live-soak, live-traffic, live-parallel, live-crdt, rallar-server-live, api-v1-black-box, browser-live, remote-live, signaling-live. Default: quick',
        '  --id=<entry-id>               Run one entry. Can be repeated.',
        '  --artifact-dir=<dir>          Write per-entry scenario artifacts and matrix-summary.json.',
        '  --list                        Print the selected matrix entries and exit.',
        '  --preflight-only              Run live-environment preflight and do not execute recipes.',
        '  --live-preflight              Alias for --preflight-only.',
        '  --require-gates               Treat skipped live gates as failures.',
        '  --shard=<index>/<count>       Run one balanced share of the selected entries, e.g. 1/2. Every share together runs each entry once.',
        '  --fail-fast                   Stop after the first failed or skipped required entry.',
        '  --verbose                     Print command output for every executed entry.',
        '  --help                        Print this help.'
    ].join('\n');
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        profile: 'quick',
        ids: [],
        list: false,
        requireGates: false,
        failFast: false,
        preflightOnly: false,
        verbose: false,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const [name, inlineValue] = arg.includes('=')
            ? arg.split(/=(.*)/s, 2)
            : [arg, undefined];
        const nextValue = (): string => {
            const value = inlineValue ?? args[++i];
            if (!value || value.startsWith('--')) {
                throw new Error('Missing value for ' + name);
            }
            return value;
        };

        switch (name) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--profile':
                options.profile = nextValue();
                break;
            case '--id':
                options.ids.push(nextValue());
                break;
            case '--artifact-dir':
            case '--artifacts':
            case '--record-dir':
                options.artifactDir = nextValue();
                break;
            case '--list':
                options.list = true;
                break;
            case '--preflight-only':
            case '--live-preflight':
                options.preflightOnly = true;
                break;
            case '--require-gates':
                options.requireGates = true;
                break;
            case '--shard':
                options.shard = parseRecipeMatrixShard(nextValue());
                break;
            case '--fail-fast':
                options.failFast = true;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            default:
                throw new Error('Unknown argument: ' + arg);
        }
    }

    return options;
}

function filePath(url: URL): string {
    return decodeURIComponent(url.pathname);
}

function repoRelativePath(url: URL): string {
    const root = filePath(REPO_ROOT).replace(/\/$/, '') + '/';
    const path = filePath(url);
    return path.startsWith(root) ? path.slice(root.length) : path;
}

async function readMatrix(): Promise<MatrixFile> {
    return JSON.parse(await readFile(MATRIX_FILE, 'utf8'));
}

async function readShardWeights(): Promise<RecipeShardWeights> {
    return JSON.parse(await readFile(SHARD_WEIGHTS_FILE, 'utf8'));
}

function selectedEntries(matrix: MatrixFile, options: CliOptions): MatrixEntry[] {
    if (options.profile === OFFLINE_VALIDATION_PROFILE) {
        const ids = new Set(options.ids);
        const candidates = options.ids.length === 0
            ? matrix.entries
            : matrix.entries.filter((entry) => ids.has(entry.id));
        const seenRecipes = new Set<string>();
        return candidates.filter((entry) => {
            if (seenRecipes.has(entry.recipe)) {
                return false;
            }

            seenRecipes.add(entry.recipe);
            return true;
        });
    }

    const byProfile = matrix.entries.filter((entry) => entry.profiles.includes(options.profile));
    if (options.ids.length === 0) {
        return byProfile;
    }

    const ids = new Set(options.ids);
    return matrix.entries.filter((entry) => ids.has(entry.id));
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    }
    catch (_error) {
        return false;
    }
}

async function hasPlaywrightCli(): Promise<boolean> {
    const child = Bun.spawn({
        cmd: ['npx', 'playwright', '--version'],
        cwd: filePath(REPO_ROOT),
        stdout: 'ignore',
        stderr: 'ignore'
    });

    return await child.exited === 0;
}

function entryArtifactDir(options: CliOptions, entry: MatrixEntry): string | undefined {
    if (!options.artifactDir) {
        return undefined;
    }

    return [
        options.artifactDir.replace(/\/+$/, ''),
        entry.artifactName ?? entry.id
    ].join('/');
}

function commandArgs(entry: MatrixEntry, options: CliOptions, artifactDir?: string): string[] {
    const recipeUrl = new URL(entry.recipe, SCRIPT_DIR);
    const args = [
        'run',
        repoRelativePath(SCENARIO_CLI),
        '-c',
        repoRelativePath(recipeUrl)
    ];

    if (options.profile === OFFLINE_VALIDATION_PROFILE) {
        args.push('--validate');
    }
    else if (entry.mode === 'dry-run') {
        args.push('--dry-run');
    }

    if (artifactDir) {
        args.push('--artifact-dir=' + artifactDir);
    }

    return args;
}

function entryEnvironment(entry: MatrixEntry): Record<string, string | undefined> {
    return {
        ...process.env,
        ...(entry.env ?? {})
    };
}

async function readRecipeConfig(entry: MatrixEntry): Promise<any> {
    return JSON.parse(await readFile(filePath(new URL(entry.recipe, SCRIPT_DIR)), 'utf8'));
}

async function writePreflightReport(
    artifactDir: string | undefined,
    report: BlackBoxRunnerLivePreflightReport
): Promise<string | undefined> {
    if (!artifactDir) {
        return undefined;
    }

    await mkdir(artifactDir, { recursive: true });
    const path = artifactDir.replace(/\/+$/, '') + '/preflight-report.json';
    await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
    return path;
}

function toMatrixPreflightSummary(
    report: BlackBoxRunnerLivePreflightReport,
    reportPath: string | undefined
): MatrixPreflightSummary {
    return {
        ok: report.ok,
        ...(reportPath ? { reportPath } : {}),
        summary: report.summary,
        issueCodes: report.issues.map((issue) => issue.code),
        skipReasons: blackBoxRunnerLivePreflightSkipReasons(report)
    };
}

async function runEntryPreflight(
    entry: MatrixEntry,
    options: CliOptions,
    artifactDir: string | undefined
): Promise<MatrixPreflightSummary | undefined> {
    if (options.profile === OFFLINE_VALIDATION_PROFILE) {
        return undefined;
    }

    const config = await readRecipeConfig(entry);
    if (!shouldRunBlackBoxRunnerLivePreflight({ config, requires: entry.requires })) {
        return undefined;
    }

    const report = await runBlackBoxRunnerLivePreflight({
        entryId: entry.id,
        profile: options.profile,
        recipe: entry.recipe,
        config,
        requires: entry.requires,
        environment: entryEnvironment(entry),
        checkPlaywright: hasPlaywrightCli
    });
    const reportPath = await writePreflightReport(artifactDir, report);
    return toMatrixPreflightSummary(report, reportPath);
}

function parseReportSummary(stdout: string): any {
    try {
        return JSON.parse(stdout)?.summary;
    }
    catch (_error) {
        return undefined;
    }
}

function expectedExitCodeFor(entry: MatrixEntry, options: CliOptions): number {
    return options.profile === OFFLINE_VALIDATION_PROFILE ? 0 : entry.expectedExitCode;
}

async function runEntry(entry: MatrixEntry, options: CliOptions): Promise<MatrixRun> {
    const recipePath = filePath(new URL(entry.recipe, SCRIPT_DIR));
    if (!(await fileExists(recipePath))) {
        return {
            id: entry.id,
            recipe: entry.recipe,
            status: 'SKIPPED',
            reasons: [`recipe file does not exist: ${entry.recipe}`]
        };
    }

    const artifactDir = entryArtifactDir(options, entry);
    const startedAt = Date.now();
    const preflight = await runEntryPreflight(entry, options, artifactDir);
    if (preflight && !preflight.ok) {
        return {
            id: entry.id,
            recipe: entry.recipe,
            status: 'SKIPPED',
            reasons: [...preflight.skipReasons],
            preflight
        };
    }

    if (options.preflightOnly) {
        const endedAt = Date.now();
        return {
            id: entry.id,
            recipe: entry.recipe,
            status: 'PASSED',
            expectedExitCode: expectedExitCodeFor(entry, options),
            code: 0,
            durationMs: endedAt - startedAt,
            artifactDir,
            summary: preflight
                ? {
                    preflight: preflight.summary
                }
                : {
                    preflight: {
                        notRequired: true
                    }
                },
            ...(preflight ? { preflight } : {})
        };
    }

    const expectedExitCode = expectedExitCodeFor(entry, options);
    const child = Bun.spawn({
        cmd: [process.execPath, ...commandArgs(entry, options, artifactDir)],
        cwd: filePath(REPO_ROOT),
        env: {
            ...process.env,
            ...(entry.env ?? {})
        },
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ]);
    const endedAt = Date.now();
    const passed = exitCode === expectedExitCode;

    return {
        id: entry.id,
        recipe: entry.recipe,
        status: passed ? 'PASSED' : 'FAILED',
        expectedExitCode,
        code: exitCode,
        durationMs: endedAt - startedAt,
        artifactDir,
        summary: parseReportSummary(stdout),
        ...(options.verbose || !passed ? { stdout, stderr } : {}),
        ...(preflight ? { preflight } : {})
    };
}

async function writeMatrixSummary(options: CliOptions, runs: MatrixRun[]): Promise<void> {
    if (!options.artifactDir) {
        return;
    }

    await mkdir(options.artifactDir, { recursive: true });
    await writeFile(
        options.artifactDir.replace(/\/+$/, '') + '/matrix-summary.json',
        JSON.stringify(
            {
                generatedAtEpochMs: Date.now(),
                profile: options.profile,
                requireGates: options.requireGates,
                preflightOnly: options.preflightOnly,
                runs,
                summary: summarize(runs)
            },
            null,
            2
        ),
        'utf8'
    );
}

function summarize(runs: MatrixRun[]): Record<string, number> {
    return runs.reduce<Record<string, number>>((summary, run) => {
        summary[run.status] = (summary[run.status] ?? 0) + 1;
        return summary;
    }, {
        PASSED: 0,
        FAILED: 0,
        SKIPPED: 0
    });
}

function printList(entries: readonly MatrixEntry[]): void {
    entries.forEach((entry) => {
        console.log(`${entry.id} | ${entry.mode} | ${entry.recipe} | ${entry.profiles.join(',')}`);
    });
}

function printRun(run: MatrixRun): void {
    if (run.status === 'SKIPPED') {
        console.log(`SKIP ${run.id}: ${run.reasons.join('; ')}`);
        return;
    }

    const expectation = run.expectedExitCode === run.code
        ? ''
        : ` expected=${run.expectedExitCode}`;
    const summary = run.summary
        ? ` success=${run.summary.success ?? '?'} failure=${run.summary.failure ?? '?'}`
        : '';
    console.log(`${run.status} ${run.id}: exit=${run.code}${expectation} durationMs=${run.durationMs}${summary}`);

    if (run.stdout?.trim()) {
        console.log(run.stdout);
    }

    if (run.stderr?.trim()) {
        console.error(run.stderr);
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }

    const matrix = await readMatrix();
    const selected = selectedEntries(matrix, options);
    const entries = options.shard === undefined
        ? selected
        : resolveRecipeMatrixShard({ entries: selected, shard: options.shard, weights: await readShardWeights() });
    if (entries.length === 0) {
        throw new Error('No recipe matrix entries selected for profile ' + options.profile);
    }

    if (options.list) {
        printList(entries);
        return;
    }

    const runs: MatrixRun[] = [];
    for (const entry of entries) {
        const run = await runEntry(entry, options);
        runs.push(run);
        printRun(run);

        const requiredSkip = run.status === 'SKIPPED' && options.requireGates;
        if ((run.status === 'FAILED' || requiredSkip) && options.failFast) {
            break;
        }
    }

    await writeMatrixSummary(options, runs);

    const summary = summarize(runs);
    console.log(
        `Matrix profile ${options.profile}: passed=${summary.PASSED} failed=${summary.FAILED} skipped=${summary.SKIPPED}`
    );

    if (summary.FAILED > 0 || (options.requireGates && summary.SKIPPED > 0)) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
