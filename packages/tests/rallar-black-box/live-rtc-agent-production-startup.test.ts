import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    prepareFullStackRtcProduction,
    type FullStackRtcProductionAttempt,
    type FullStackRtcProductionConfiguration
} from '../../../apps/rallar-black-box/playwright-full-stack-spa-server.ts';
import {
    openLiveRtcBrowserEntry,
    type LiveRtcBrowserEntryPage,
    type OpenLiveRtcBrowserAgentInput
} from '../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts';
import { loadLiveRtcPerformanceAttempt } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';
import type { RtcBaselineCaseKeyDto } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

interface StartupFixture {
    readonly repoRoot: string;
    readonly attempt: FullStackRtcProductionAttempt;
    readonly configuration: FullStackRtcProductionConfiguration;
}

interface StartupAttemptInput {
    readonly repoRoot: string;
    readonly baselineId: string;
    readonly environmentId: 'E3-memory' | 'E4-pg';
    readonly observation: FullStackRtcProductionAttempt['runtimeObservation'];
}

const provenance = vi.hoisted(() => ({
    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/fixture', clean: true }
}));
const index = '<script type="module" src="/assets/entry.js"></script>';
const script = 'export const value = 42;';
const toolPath = 'node_modules/fixture-tool.js';

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    const { promisify } = await import('node:util');
    const outputs: Record<string, string> = {
        'rev-parse HEAD': provenance.git.headCommit,
        'rev-parse HEAD^{tree}': provenance.git.headTree,
        'branch --show-current': provenance.git.ref,
        'status --porcelain=v1': ''
    };
    return {
        ...original,
        execFile: Object.assign(() => {}, {
            [promisify.custom]: async (command: string, arguments_: readonly string[]) => {
                const stdout = command === 'node' && arguments_.at(-1)?.endsWith('/read-full-stack-rtc-build-tool-inputs.ts')
                    ? JSON.stringify([toolPath])
                    : command === 'git'
                    ? outputs[arguments_.join(' ')]
                    : undefined;
                if (stdout === undefined) {
                    throw new Error('Unowned fixture command.');
                }
                return { stdout, stderr: '' };
            }
        })
    };
});

beforeEach(() => {
    vi.resetModules();
    for (
        const key of [
            'RALLAR_BLACK_BOX_RTC_BASELINE_ID',
            'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE',
            'RALLAR_BLACK_BOX_ALM_DIAGNOSTICS',
            'RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS',
            'VITE_RALLAR_EVENT_HISTORY',
            'VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS'
        ]
    ) {
        vi.stubEnv(key, undefined);
    }
    vi.stubEnv('VITE_RALLAR_API_BASE_URL', 'http://localhost:18080');
    vi.stubEnv('VITE_RALLAR_SPA_BASE_URL', 'http://localhost:5177');
    onTestFinished(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.resetModules();
    });
});

it.each(['E3-memory', 'E4-pg'] as const)('records original browser bytes after %s environment admission', async (environmentId) => {
    const fixture = await createStartupFixture(environmentId);
    const environment = await import('../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts');
    const config = environment.liveRtcAgentConfig();
    const page = createEntryPage();

    await openLiveRtcBrowserEntry(page, createAgentInput(config), new URLSearchParams({ password: 'private' }));

    const entries = await readFile(join(fixture.configuration.buildRoot, 'entries.jsonl'), 'utf8');
    expect(entries.trim().split('\n').map((line) => JSON.parse(line).path)).toEqual(['index.html', 'assets/entry.js']);
    expect(entries).not.toContain('private');
    expect(config.productionBuild?.seal.attempt.environmentId).toBe(environmentId);
    expect(config.eventHistory).toEqual(environmentId === 'E3-memory' ? { mode: 'recent', maxEvents: 64 } : { mode: 'full' });
});

it('keeps ordinary browser navigation available without a governed attempt', async () => {
    vi.stubEnv('RALLAR_BLACK_BOX_RTC_BUILD_ROOT', '/unowned/missing-build');
    const environment = await import('../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts');
    const urls: string[] = [];
    const page: LiveRtcBrowserEntryPage = {
        goto: async (url) => {
            urls.push(url);
        },
        on: () => {
            throw new Error('Ungoverned navigation needs no proof listener.');
        },
        off: () => {
            throw new Error('Ungoverned navigation needs no proof listener.');
        }
    };
    await openLiveRtcBrowserEntry(page, createAgentInput(environment.liveRtcAgentConfig()), new URLSearchParams({ mode: 'control' }));
    expect(urls).toEqual(['http://localhost:5177/?mode=control']);
});

it.each(
    [
        ['E3-memory', 'missing-seal'],
        ['E4-pg', 'missing-seal'],
        ['E3-memory', 'changed-build'],
        ['E4-pg', 'changed-build'],
        ['E3-memory', 'changed-response'],
        ['E4-pg', 'changed-response']
    ] as const
)('refuses %s %s original proof at environment admission', async (environmentId, failure) => {
    const fixture = await createStartupFixture(environmentId);
    if (failure === 'missing-seal') {
        await rm(join(fixture.configuration.buildRoot, 'seal.json'));
    }
    if (failure === 'changed-build') {
        await writeFile(join(fixture.configuration.buildRoot, 'output/assets/entry.js'), 'different original bytes');
    }
    if (failure === 'changed-response') {
        vi.stubGlobal('fetch', async () => new Response('different served bytes'));
    }
    await expect(import('../../../tests/playwright/rallar-black-box/live-rtc-agent-environment.ts'))
        .rejects.toThrow(
            failure === 'changed-response'
                ? 'Actual production served bytes did not match the sealed build.'
                : 'Production serving requires a verified original build.'
        );
});

async function createStartupFixture(environmentId: 'E3-memory' | 'E4-pg'): Promise<StartupFixture> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'rtc-startup-'));
    onTestFinished(() => rm(repoRoot, { recursive: true, force: true }));
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    const baselineId = `20261018T100000000Z-0123456789ab-${environmentId.toLowerCase()}-local`;
    const inputKey = environmentId === 'E3-memory' ? 'e3-memory-default' : 'e4-pg-default';
    const caseKey = { workloadId: 'RTC-B06', caseId: 'default', inputKey } as const;
    const buildRoot = join(repoRoot, 'tmp/perf/rtc-b06-private-build', baselineId, 'default/retained-1');
    const observation = createRuntimeObservation(caseKey);
    await writeAttemptInputs({ repoRoot, baselineId, environmentId, observation });
    for (
        const [key, value] of Object.entries({
            RALLAR_BLACK_BOX_RTC_BASELINE_ID: baselineId,
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'default',
            RALLAR_BLACK_BOX_RTC_INPUT_KEY: inputKey,
            RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'retained',
            RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1',
            RALLAR_BLACK_BOX_RTC_BUILD_ROOT: buildRoot,
            NODE_ENV: 'production',
            VITE_RALLAR_EVENT_HISTORY: environmentId === 'E3-memory' ? 'recent' : 'full'
        })
    ) {
        vi.stubEnv(key, value);
    }
    vi.stubEnv('VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS', environmentId === 'E3-memory' ? '64' : undefined);
    const attempt = await loadLiveRtcPerformanceAttempt({ repoRoot, environment: process.env });
    if (!attempt) {
        throw new Error('Fixture attempt was not admitted.');
    }
    const configuration = { buildRoot, apiBaseUrl: 'http://localhost:18080', spaBaseUrl: 'http://localhost:5177', environment: process.env };
    const fixture = { repoRoot, attempt, configuration };
    await prepareStartupBuild(fixture);
    vi.stubGlobal('fetch', async (url: string) => {
        const path = new URL(url).pathname;
        return new Response(await readFile(join(buildRoot, 'output', path === '/' ? 'index.html' : path)));
    });
    return fixture;
}

async function prepareStartupBuild(fixture: StartupFixture): Promise<void> {
    const { buildRoot } = fixture.configuration;
    const { baselineId } = fixture.attempt;
    await mkdir(join(buildRoot, 'output'), { recursive: true });
    await writeFile(join(buildRoot, 'owner.json'), JSON.stringify({ baselineId, attempt: fixture.attempt.locator }));
    const prepared = await prepareFullStackRtcProduction(fixture.attempt, fixture.configuration, {
        readGit: async () => provenance.git,
        readBuildToolInputs: async () => [toolPath],
        build: async () => {
            await writeBuildOutput(buildRoot);
            return 0;
        }
    });
    if (!prepared.right) {
        throw new Error('Fixture build was not sealed.');
    }
}

function createRuntimeObservation(caseKey: RtcBaselineCaseKeyDto): FullStackRtcProductionAttempt['runtimeObservation'] {
    return {
        git: provenance.git,
        runtime: { node: 'v24', npm: '11', deno: '2', playwright: '1', chromium: '149' },
        host: { os: 'linux', kernel: '1', architecture: 'x64', logicalCpuCount: 4, cpuModel: 'fixture', totalMemoryBytes: 1, executionContext: 'local' },
        timing: {
            startedAtUtc: '2026-10-18T10:00:00.000Z',
            endedAtUtc: '2026-10-18T10:00:01.000Z',
            monotonicDurationMs: 1000,
            monotonicSource: 'performance.now'
        },
        deviations: [],
        sourceHashes: [{ path: toolPath, kind: 'config', sha256: createHash('sha256').update(script).digest('hex') }],
        configurationInputs: [],
        controllerInputs: [],
        allowlistedEnvironment: {},
        resolvedConfiguration: ['appServingMode', 'viteMode', 'nodeEnvironment', 'buildTarget'].map((field) => ({
            caseKey,
            field,
            value: field === 'buildTarget' ? 'es2023' : 'production',
            source: 'default'
        })),
        workerCommand: { redactedArgv: { executable: 'npm', arguments: [] }, projection: { fixedWorkerFlags: [], configurationFlags: [] } }
    };
}

async function writeAttemptInputs(startup: StartupAttemptInput): Promise<void> {
    const { repoRoot, baselineId, environmentId, observation } = startup;
    const baselineRoot = join(repoRoot, 'tmp/perf/rtc-baseline', baselineId);
    const inputKey = environmentId === 'E3-memory' ? 'e3-memory-default' : 'e4-pg-default';
    const caseKey = { workloadId: 'RTC-B06', caseId: 'default', inputKey };
    await mkdir(baselineRoot, { recursive: true });
    await mkdir(join(repoRoot, 'node_modules'));
    await writeFile(join(repoRoot, toolPath), script);
    await writeFile(
        join(baselineRoot, 'manifest.json'),
        JSON.stringify({
            schema: 'rallar.rtc-baseline.manifest.v1',
            request: {
                schema: 'rallar.rtc-baseline.capture-request.v1',
                baselineId,
                workloadIds: ['RTC-B06'],
                environmentId,
                retainedSampleMultiplier: 1,
                repeatLink: null,
                conditionalEnvironmentDecisions: []
            },
            workloadIds: ['RTC-B06'],
            cases: [caseKey],
            outerAttempts: [{ ...caseKey, environmentId, intendedPhase: 'retained', outerOrdinal: 1, sampleIds: ['fixture-sample'] }],
            expectedCohorts: [],
            repeatLink: null
        })
    );
    await writeFile(
        join(baselineRoot, 'environment.json'),
        JSON.stringify({
            schema: 'rallar.rtc-baseline.environment.v1',
            baselineId,
            workloadIds: ['RTC-B06'],
            environmentId,
            repeatLink: null,
            conditionalEnvironmentDecisions: [],
            observation
        })
    );
}

async function writeBuildOutput(buildRoot: string): Promise<void> {
    await mkdir(join(buildRoot, 'output/.vite'));
    await mkdir(join(buildRoot, 'output/assets'));
    await writeFile(join(buildRoot, 'output/index.html'), index);
    await writeFile(join(buildRoot, 'output/.vite/manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/entry.js', isEntry: true } }));
    await writeFile(join(buildRoot, 'output/assets/entry.js'), script);
}

function createEntryPage(): LiveRtcBrowserEntryPage {
    let listener: Parameters<LiveRtcBrowserEntryPage['on']>[1] | undefined;
    return {
        on: (_event, registered) => {
            listener = registered;
        },
        off: () => {
            listener = undefined;
        },
        goto: async (url) => {
            for (const [path, bytes] of [['/', index], ['/assets/entry.js', script]]) {
                listener?.({ url: () => new URL(path, url).href, status: () => 200, body: async () => Buffer.from(bytes) });
            }
        }
    };
}

function createAgentInput(config: OpenLiveRtcBrowserAgentInput['config']): OpenLiveRtcBrowserAgentInput {
    return {
        config,
        prefix: 'A',
        auth: { kind: 'login', username: 'fixture-user', password: 'fixture-password' },
        runId: 'fixture-run',
        agentId: 'fixture-agent',
        actor: 'fixture-actor',
        connection: 'fixture-connection',
        groupId: 'fixture-group'
    };
}
