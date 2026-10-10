import type {
    RtcBaselineCaptureRequestDto,
    RtcBaselineIssueDto,
    RtcBaselineResult,
    RtcBaselineRuntimeObservationDto
} from '../contracts/rtc-baseline-contracts.ts';
import {
    createRtcBaselineRuntimeObservationInput,
    type RtcBaselineObservationInput
} from './create-rtc-baseline-runtime-observation-input.ts';
import {
    RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME,
    type RtcBaselineCaptureAdmission
} from './rtc-baseline-capture-admission.ts';
import type { DenoRtcBaselineAdapters } from './rtc-baseline-deno-adapters.ts';

export const RTC_BASELINE_ENVIRONMENT_NAMES = [
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES',
    'RALLAR_ICE_MODE',
    'DATABASE_URL',
    'RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR',
    'RALLAR_BLACK_BOX_RTC_BASELINE_ID',
    'RALLAR_BLACK_BOX_RTC_CASE_ID',
    'RALLAR_BLACK_BOX_RTC_INPUT_KEY',
    'RALLAR_BLACK_BOX_RTC_INTENDED_PHASE',
    'RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL',
    RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME
] as const;
const chromiumVersionScript = [
    'const { execFileSync } = require(\'node:child_process\');',
    'const { chromium } = require(\'playwright\');',
    'process.stdout.write(execFileSync(chromium.executablePath(), [\'--version\']));'
].join(' ');

interface Dependencies {
    readGit(): Promise<RtcBaselineRuntimeObservationDto['git']>;
    readRuntime(): Promise<RtcBaselineRuntimeObservationDto['runtime']>;
    readHost(): Promise<RtcBaselineRuntimeObservationDto['host']>;
    readSourceHashes(
        paths: readonly string[]
    ): Promise<RtcBaselineRuntimeObservationDto['sourceHashes']>;
    nowUtc(): string;
    monotonicNowMs(): number;
}

interface ReconcilerDependencies {
    readInitialized(baselineId: string): Promise<
        RtcBaselineResult<{
            request: RtcBaselineCaptureRequestDto;
            observation: RtcBaselineRuntimeObservationDto;
        }>
    >;
    observe(
        request: RtcBaselineCaptureRequestDto,
        initialized?: RtcBaselineRuntimeObservationDto
    ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;
    validate(
        initialized: RtcBaselineRuntimeObservationDto,
        current: RtcBaselineRuntimeObservationDto
    ): RtcBaselineIssueDto[];
}

export interface RtcBaselineRuntimeObserver {
    (
        input: RtcBaselineObservationInput
    ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;
}

export type RtcBaselineCaptureObserver = (
    request: RtcBaselineCaptureRequestDto,
    initialized?: RtcBaselineRuntimeObservationDto
) => Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;

function issue(message: string) {
    return {
        path: '$.observation',
        code: 'observation-failed',
        message: message.replace(/^Error: /, '')
    };
}

export function createRtcBaselineRuntimeReconciler(dependencies: ReconcilerDependencies) {
    return async function reconcile (
        operation: string,
        input: { baselineId?: string; }
    ): Promise<RtcBaselineIssueDto[]> {
        if (operation === 'initialize') {
            return [];
        }
        if (input.baselineId === undefined) {
            return [
                {
                    path: '$.baselineId',
                    code: 'missing-baseline-id',
                    message: 'Reconciliation requires a baseline ID.'
                }
            ];
        }
        const initialized = await dependencies.readInitialized(input.baselineId);
        if (!initialized.ok) {
            return initialized.issues;
        }
        const current = await dependencies.observe(
            initialized.value.request,
            initialized.value.observation
        );
        if (!current.ok) {
            return current.issues;
        }
        return dependencies.validate(initialized.value.observation, current.value);
    };
}

export function createRtcBaselineRuntimeObservation(
    dependencies: Dependencies
): RtcBaselineRuntimeObserver {
    return async function observe (input: RtcBaselineObservationInput) {
        const startedAtUtc = dependencies.nowUtc();
        const startedAt = dependencies.monotonicNowMs();
        try {
            const git = await dependencies.readGit();
            const runtime = await dependencies.readRuntime();
            const host = await dependencies.readHost();
            const sourceHashes = await dependencies.readSourceHashes(input.sourcePaths);
            const endedAtUtc = dependencies.nowUtc();
            const endedAt = dependencies.monotonicNowMs();
            return {
                ok: true as const,
                value: {
                    git,
                    runtime,
                    host,
                    timing: {
                        startedAtUtc,
                        endedAtUtc,
                        monotonicDurationMs: endedAt - startedAt,
                        monotonicSource: 'performance.now'
                    },
                    deviations: input.deviations,
                    sourceHashes,
                    configurationInputs: input.configurationInputs,
                    resolvedConfiguration: input.resolvedConfiguration,
                    controllerInputs: input.controllerInputs,
                    workerCommand: input.workerCommand,
                    allowlistedEnvironment: input.allowlistedEnvironment
                }
            };
        }
        catch (error) {
            return { ok: false as const, issues: [issue(String(error))] };
        }
    };
}

type RtcBaselineDenoObservationAdapters = Pick<
    DenoRtcBaselineAdapters,
    'git' | 'runtimeHost' | 'process' | 'sourceConfigHashing' | 'environment' | 'clock'
>;

function createDenoRuntimeObserver(adapters: RtcBaselineDenoObservationAdapters): RtcBaselineRuntimeObserver {
    function unwrap<T>(result: RtcBaselineResult<T>): T {
        if (!result.ok) {
            throw new Error(JSON.stringify(result.issues));
        }
        return result.value;
    }
    return createRtcBaselineRuntimeObservation({
        async readGit() {
            const [headCommit, headTree, ref, status] = await Promise.all([
                adapters.git.readHeadCommit(),
                adapters.git.readHeadTree(),
                adapters.git.readRef(),
                adapters.git.readStatus()
            ]);
            return {
                headCommit: unwrap(headCommit),
                headTree: unwrap(headTree),
                ref: unwrap(ref),
                clean: unwrap(status).length === 0
            };
        },
        async readRuntime() {
            const host = await adapters.runtimeHost.read();
            const version = async (executable: string) =>
                unwrap(await adapters.process.run({ executable, arguments: ['--version'] })).stdout.trim();
            const nodeValue = async (script: string) =>
                unwrap(
                    await adapters.process.run({ executable: 'node', arguments: ['--eval', script] })
                ).stdout.trim();
            return {
                node: await version('node'),
                npm: await version('npm'),
                deno: host.deno,
                playwright: await nodeValue('console.log(require(\'playwright/package.json\').version)'),
                chromium: await nodeValue(chromiumVersionScript)
            };
        },
        readHost: async () => {
            const { deno: _deno, ...host } = await adapters.runtimeHost.read();
            return { ...host, executionContext: host.executionContext ?? 'local' };
        },
        readSourceHashes: async () => [],
        nowUtc: adapters.clock.nowUtc,
        monotonicNowMs: adapters.clock.monotonicNowMs
    });
}

export function createRtcBaselineDenoObservation(
    adapters: Pick<
        DenoRtcBaselineAdapters,
        'git' | 'runtimeHost' | 'process' | 'sourceConfigHashing' | 'environment' | 'clock'
    >,
    captureAdmission?: RtcBaselineCaptureAdmission
): RtcBaselineCaptureObserver {
    const observe = createDenoRuntimeObserver(adapters);
    return async (request, initialized) => {
        const environment = adapters.environment.readAllowlisted(RTC_BASELINE_ENVIRONMENT_NAMES);
        const input = createRtcBaselineRuntimeObservationInput(request, environment, { initialized, captureAdmission });
        if (!input.ok) {
            return input;
        }
        const observed = await observe(input.value.observation);
        if (!observed.ok) {
            return observed;
        }
        const hashes = await adapters.sourceConfigHashing.read(input.value.files);
        return hashes.ok
            ? {
                ok: true as const,
                value: {
                    ...observed.value,
                    host: {
                        ...observed.value.host,
                        executionContext: request.environmentId === 'E5-remote' ? 'distributed' : 'local'
                    },
                    sourceHashes: hashes.value
                }
            }
            : hashes;
    };
}
