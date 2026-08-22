import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type WorldFleetDistributedRecipeRunnerOptions = Readonly<{
    controlBaseUrl: string;
    manifestPath: string;
    controlRunId?: string;
    token?: string;
    artifactDir?: string;
    pollMs: number;
    timeoutMs: number;
    fetchFn?: typeof fetch;
}>;

const TERMINAL_STATES = new Set(['passed', 'failed', 'cancelled', 'timed-out']);

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2), process.env);
    await runWorldFleetDistributedRecipe(options);
}

export async function runWorldFleetDistributedRecipe(
    options: WorldFleetDistributedRecipeRunnerOptions
): Promise<void> {
    const manifest = applyWorldFleetControlRunIdOverride(
        JSON.parse(await readFile(options.manifestPath, 'utf8')) as RallarBlackBoxDistributedRunManifest,
        options.controlRunId
    );

    console.log(`world-fleet no-spawn runner: ${manifest.distributedRunId}`);
    console.log(`control server: ${options.controlBaseUrl}`);
    console.log(`manifest: ${options.manifestPath}`);
    if (options.controlRunId) {
        console.log(`control run override: ${options.controlRunId}`);
    }

    const resolution = await postJson<RallarBlackBoxDistributedTargetResolution>(
        options,
        '/distributed-runs/resolve-targets',
        { manifest }
    );
    const expected = manifest.targetPolicy.expectedParticipantCount;
    console.log(
        `target preflight: selected ${resolution.summary.selected}/${
            expected ?? 'unspecified'
        }; blockers ${resolution.blockers.length}`
    );
    console.log(`role counts: ${JSON.stringify(resolution.summary.roleCounts)}`);
    console.log(`regions: ${JSON.stringify(resolution.summary.regions)}`);
    console.log(`providers: ${JSON.stringify(resolution.summary.providers)}`);

    if (expected !== undefined && resolution.summary.selected !== expected) {
        throw new Error(
            `Target preflight mismatch: selected ${resolution.summary.selected}, expected ${expected}.`
        );
    }

    const created = await postJson<ControlDistributedRunSnapshot>(options, '/distributed-runs', { manifest });
    console.log(`created: ${created.state}`);

    const staged = await postJson<ControlDistributedRunSnapshot>(
        options,
        `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}/stage`,
        {}
    );
    console.log(`staged: ${staged.state}`);

    const ready = await waitForState(
        options,
        manifest.distributedRunId,
        (run) => run.state === 'ready' || run.state === 'running' || TERMINAL_STATES.has(run.state)
    );
    if (ready.state !== 'ready' && ready.state !== 'running') {
        await exportDistributedRunArtifacts(options, manifest);
        throw new Error(`Distributed run reached ${ready.state} before start.`);
    }

    if (ready.state === 'ready') {
        const started = await postJson<ControlDistributedRunSnapshot>(
            options,
            `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}/start`,
            {}
        );
        console.log(`started: ${started.state}`);
    }

    const terminal = await waitForState(options, manifest.distributedRunId, (run) => TERMINAL_STATES.has(run.state));
    console.log(`terminal: ${terminal.state}`);

    await exportDistributedRunArtifacts(options, manifest);

    if (terminal.state !== 'passed') {
        throw new Error(`Distributed run did not pass: ${terminal.state}.`);
    }
}

export function applyWorldFleetControlRunIdOverride(
    manifest: RallarBlackBoxDistributedRunManifest,
    controlRunId?: string
): RallarBlackBoxDistributedRunManifest {
    const cleanControlRunId = controlRunId?.trim();
    return cleanControlRunId
        ? {
            ...manifest,
            controlRunId: cleanControlRunId
        }
        : manifest;
}

async function exportDistributedRunArtifacts(
    options: WorldFleetDistributedRecipeRunnerOptions,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<void> {
    const bundle = await getJson<ControlDistributedRunArtifactBundle>(
        options,
        `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}/artifacts`
    );
    const artifactDir = options.artifactDir ??
        path.join('artifacts', 'world-fleet', manifest.distributedRunId);
    await writeArtifactBundle(artifactDir, bundle);
    console.log(`artifacts: ${artifactDir}`);
}

async function waitForState(
    options: WorldFleetDistributedRecipeRunnerOptions,
    distributedRunId: string,
    predicate: (run: ControlDistributedRunSnapshot) => boolean
): Promise<ControlDistributedRunSnapshot> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= options.timeoutMs) {
        const snapshot = await getJson<ControlDistributedRunSnapshot>(
            options,
            `/distributed-runs/${encodeURIComponent(distributedRunId)}`
        );
        if (predicate(snapshot)) {
            return snapshot;
        }
        await delay(options.pollMs);
    }
    throw new Error(`Timed out waiting for distributed run ${distributedRunId}.`);
}

async function writeArtifactBundle(
    artifactDir: string,
    bundle: ControlDistributedRunArtifactBundle
): Promise<void> {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
        path.join(artifactDir, 'artifact-bundle.json'),
        `${JSON.stringify(bundle, null, 2)}\n`
    );
    for (const [fileName, contents] of Object.entries(bundle.files)) {
        const safeFileName = safeArtifactBundleFileName(fileName);
        if (!safeFileName) {
            console.warn(`Skipping unsafe artifact bundle file name: ${fileName}`);
            continue;
        }
        await writeFile(path.join(artifactDir, safeFileName), contents.endsWith('\n') ? contents : `${contents}\n`);
    }
}

function safeArtifactBundleFileName(fileName: string): string | undefined {
    if (
        fileName.length === 0 ||
        fileName.includes('\0') ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        path.isAbsolute(fileName) ||
        fileName === '.' ||
        fileName === '..'
    ) {
        return undefined;
    }
    return fileName;
}

async function postJson<T>(
    options: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string,
    body: unknown
): Promise<T> {
    return await jsonRequest<T>(options, pathname, {
        method: 'POST',
        body: JSON.stringify(body)
    });
}

async function getJson<T>(
    options: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string
): Promise<T> {
    return await jsonRequest<T>(options, pathname, { method: 'GET' });
}

async function jsonRequest<T>(
    options: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string,
    init: RequestInit
): Promise<T> {
    const response = await (options.fetchFn ?? fetch)(new URL(pathname, normalizedBaseUrl(options.controlBaseUrl)), {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...init.headers
        }
    });
    if (!response.ok) {
        throw new Error(`${init.method ?? 'GET'} ${pathname} failed with ${response.status}: ${await response.text()}`);
    }
    return await response.json() as T;
}

function parseArgs(
    args: readonly string[],
    env: NodeJS.ProcessEnv
): WorldFleetDistributedRecipeRunnerOptions {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (!arg.startsWith('--')) {
            throw new Error(`Unexpected argument: ${arg}`);
        }
        const key = arg.slice(2);
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for --${key}`);
        }
        values.set(key, value);
        index += 1;
    }

    const controlBaseUrl = values.get('control') ?? env.RALLAR_CONTROL_BASE_URL;
    const manifestPath = values.get('manifest');
    if (!controlBaseUrl || !manifestPath) {
        printUsage();
        throw new Error('Missing --control and/or --manifest.');
    }

    return {
        controlBaseUrl,
        manifestPath,
        controlRunId: values.get('control-run-id') ?? env.RALLAR_CONTROL_RUN_ID,
        token: values.get('token') ?? env.RALLAR_CONTROL_ADMIN_TOKEN,
        artifactDir: values.get('artifact-dir'),
        pollMs: positiveInteger(values.get('poll-ms'), 2_000),
        timeoutMs: positiveInteger(values.get('timeout-ms'), 30 * 60_000)
    };
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedBaseUrl(value: string): URL {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }
    return url;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
    console.log(`Usage:
  npx tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts \\
    --control http://127.0.0.1:5180 \\
    --manifest apps/rallar-black-box/manifests/world-fleet/01-rtc-messages-principal-50-agent-30s-20hz-tree.json \\
    --control-run-id live-world-fleet-control-run \\
    --token "$RALLAR_CONTROL_ADMIN_TOKEN" \\
    --artifact-dir artifacts/world-fleet/principal-30s-tree \\
    --timeout-ms 3900000

This runner never starts, stops, installs, or restarts headless agents. It only
preflights, creates, stages, starts, polls, and exports through an existing
control server.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
