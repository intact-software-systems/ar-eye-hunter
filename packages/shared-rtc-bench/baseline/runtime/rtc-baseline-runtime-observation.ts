import { RTC_BASELINE_WORKLOAD_CATALOG } from '../catalog/rtc-baseline-workload-catalog.ts';
import type {
  RtcBaselineCaptureRequestDto,
  RtcBaselineControllerInputDto,
  RtcBaselineIssueDto,
  RtcBaselineResolvedConfigurationValueDto,
  RtcBaselineResult,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineWorkerCommandDto,
} from '../contracts/rtc-baseline-contracts.ts';
import type { DenoRtcBaselineAdapters } from './rtc-baseline-deno-adapters.ts';
import { resolveRtcBaselineConfiguration } from '../contracts/rtc-baseline-validation.ts';

export interface RtcBaselineObservationInput {
  sourcePaths: readonly string[];
  configurationInputs: readonly RtcBaselineControllerInputDto[];
  controllerInputs: readonly RtcBaselineControllerInputDto[];
  resolvedConfiguration: readonly RtcBaselineResolvedConfigurationValueDto[];
  workerCommand: RtcBaselineWorkerCommandDto;
  deviations: readonly string[];
  allowlistedEnvironment: Readonly<Record<string, string>>;
}

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
] as const;
const chromiumVersionScript = [
  "const { execFileSync } = require('node:child_process');",
  "const { chromium } = require('playwright');",
  "process.stdout.write(execFileSync(chromium.executablePath(), ['--version']));",
].join(' ');

interface Dependencies {
  readGit(): Promise<RtcBaselineRuntimeObservationDto['git']>;
  readRuntime(): Promise<RtcBaselineRuntimeObservationDto['runtime']>;
  readHost(): Promise<RtcBaselineRuntimeObservationDto['host']>;
  readSourceHashes(
    paths: readonly string[],
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
    initialized?: RtcBaselineRuntimeObservationDto,
  ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;
  validate(
    initialized: RtcBaselineRuntimeObservationDto,
    current: RtcBaselineRuntimeObservationDto,
  ): RtcBaselineIssueDto[];
}

export interface RtcBaselineRuntimeObserver {
  (
    input: RtcBaselineObservationInput,
  ): Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;
}

export interface RtcBaselineRuntimeObservationSetup {
  files: readonly { path: string; kind: 'source' | 'config' }[];
  observation: RtcBaselineObservationInput;
}

export type RtcBaselineCaptureObserver = (
  request: RtcBaselineCaptureRequestDto,
  initialized?: RtcBaselineRuntimeObservationDto,
) => Promise<RtcBaselineResult<RtcBaselineRuntimeObservationDto>>;

function issue(message: string) {
  return {
    path: '$.observation',
    code: 'observation-failed',
    message: message.replace(/^Error: /, ''),
  };
}

function redactPersistedEnvironment(values: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      name === 'DATABASE_URL' ? (value.length > 0 ? 'present' : 'absent') : value,
    ]),
  );
}

export function createRtcBaselineRuntimeObservationInput(
  request: RtcBaselineCaptureRequestDto,
  allowlistedEnvironment: Readonly<Record<string, string>>,
  initialized?: RtcBaselineRuntimeObservationDto,
): RtcBaselineResult<RtcBaselineRuntimeObservationSetup> {
  const cases = request.workloadIds.flatMap((workloadId: string) => {
    const workload = RTC_BASELINE_WORKLOAD_CATALOG.find((entry) => entry.workloadId === workloadId);
    if (!workload) return [];
    return workload.cases.filter((entry) =>
      workloadId === 'RTC-B06'
        ? entry.inputKey.startsWith(request.environmentId.toLowerCase())
        : true,
    );
  });
  const files = cases.flatMap(
    (entry: { sourcePaths: readonly string[]; configPaths: readonly string[] }) => [
      ...entry.sourcePaths.map((path: string) => ({ path, kind: 'source' as const })),
      ...entry.configPaths.map((path: string) => ({ path, kind: 'config' as const })),
    ],
  );
  const uniqueFiles = files.filter(
    (entry, index) => files.findIndex((candidate) => candidate.path === entry.path) === index,
  );
  const runtime = cases[0]?.runtime ?? { executable: 'deno', prefixArguments: [] };
  const resolvedConfiguration: RtcBaselineResolvedConfigurationValueDto[] = [];
  const configurationInputs: RtcBaselineControllerInputDto[] = [];
  for (const descriptor of cases.flatMap((entry) => entry.configuration)) {
    const initializedValue = initialized?.resolvedConfiguration.find(
      (entry) =>
        entry.field === descriptor.field &&
        JSON.stringify(entry.caseKey) === JSON.stringify(descriptor.caseKey),
    );
    const environmentName = descriptor.allowlistedEnvironmentVariable;
    const environmentValue = environmentName ? allowlistedEnvironment[environmentName] : undefined;
    const resolved = resolveRtcBaselineConfiguration(descriptor, {
      cliValue: initializedValue?.source === 'cli' ? initializedValue.value : undefined,
      environmentValue,
    });
    if (!resolved.ok) return resolved;
    resolvedConfiguration.push(resolved.value);
    if (resolved.value.source === 'environment') {
      configurationInputs.push({ name: environmentName!, value: environmentValue!, secret: false });
    }
  }
  const controllerInputs = initialized?.controllerInputs ?? [
    { name: 'baselineId', value: request.baselineId, secret: false },
    { name: 'workloadIds', value: request.workloadIds.join(','), secret: false },
    { name: 'environmentId', value: request.environmentId, secret: false },
  ];
  return {
    ok: true,
    value: {
      files: uniqueFiles,
      observation: {
        sourcePaths: uniqueFiles.map((entry) => entry.path),
        configurationInputs,
        resolvedConfiguration,
        controllerInputs,
        workerCommand: {
          redactedArgv: { executable: runtime.executable, arguments: runtime.prefixArguments },
          projection: { fixedWorkerFlags: [], configurationFlags: [] },
        },
        deviations: [],
        allowlistedEnvironment: redactPersistedEnvironment(allowlistedEnvironment),
      },
    },
  };
}

export function createRtcBaselineRuntimeReconciler(dependencies: ReconcilerDependencies) {
  return async function reconcile(
    operation: string,
    input: { baselineId?: string },
  ): Promise<RtcBaselineIssueDto[]> {
    if (operation === 'initialize') return [];
    if (input.baselineId === undefined) {
      return [
        {
          path: '$.baselineId',
          code: 'missing-baseline-id',
          message: 'Reconciliation requires a baseline ID.',
        },
      ];
    }
    const initialized = await dependencies.readInitialized(input.baselineId);
    if (!initialized.ok) return initialized.issues;
    const current = await dependencies.observe(
      initialized.value.request,
      initialized.value.observation,
    );
    if (!current.ok) return current.issues;
    return dependencies.validate(initialized.value.observation, current.value);
  };
}

export function createRtcBaselineRuntimeObservation(
  dependencies: Dependencies,
): RtcBaselineRuntimeObserver {
  return async function observe(input: RtcBaselineObservationInput) {
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
            monotonicSource: 'performance.now',
          },
          deviations: input.deviations,
          sourceHashes,
          configurationInputs: input.configurationInputs,
          resolvedConfiguration: input.resolvedConfiguration,
          controllerInputs: input.controllerInputs,
          workerCommand: input.workerCommand,
          allowlistedEnvironment: input.allowlistedEnvironment,
        },
      };
    } catch (error) {
      return { ok: false as const, issues: [issue(String(error))] };
    }
  };
}

export function createRtcBaselineDenoObservation(
  adapters: Pick<
    DenoRtcBaselineAdapters,
    'git' | 'runtimeHost' | 'process' | 'sourceConfigHashing' | 'environment' | 'clock'
  >,
): RtcBaselineCaptureObserver {
  function unwrap<T>(result: RtcBaselineResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.value;
  }
  const observe = createRtcBaselineRuntimeObservation({
    async readGit() {
      const [headCommit, headTree, ref, status] = await Promise.all([
        adapters.git.readHeadCommit(),
        adapters.git.readHeadTree(),
        adapters.git.readRef(),
        adapters.git.readStatus(),
      ]);
      return {
        headCommit: unwrap(headCommit),
        headTree: unwrap(headTree),
        ref: unwrap(ref),
        clean: unwrap(status).length === 0,
      };
    },
    async readRuntime() {
      const host = await adapters.runtimeHost.read();
      const version = async (executable: string) =>
        unwrap(await adapters.process.run({ executable, arguments: ['--version'] })).stdout.trim();
      const nodeValue = async (script: string) =>
        unwrap(
          await adapters.process.run({ executable: 'node', arguments: ['--eval', script] }),
        ).stdout.trim();
      return {
        node: await version('node'),
        npm: await version('npm'),
        deno: host.deno,
        playwright: await nodeValue("console.log(require('playwright/package.json').version)"),
        chromium: await nodeValue(chromiumVersionScript),
      };
    },
    readHost: async () => {
      const { deno: _deno, ...host } = await adapters.runtimeHost.read();
      return { ...host, executionContext: host.executionContext ?? 'local' };
    },
    readSourceHashes: async () => [],
    nowUtc: adapters.clock.nowUtc,
    monotonicNowMs: adapters.clock.monotonicNowMs,
  });
  return async (request, initialized) => {
    const environment = adapters.environment.readAllowlisted(RTC_BASELINE_ENVIRONMENT_NAMES);
    const input = createRtcBaselineRuntimeObservationInput(request, environment, initialized);
    if (!input.ok) return input;
    const observed = await observe(input.value.observation);
    if (!observed.ok) return observed;
    const hashes = await adapters.sourceConfigHashing.read(input.value.files);
    return hashes.ok
      ? {
          ok: true as const,
          value: {
            ...observed.value,
            host: {
              ...observed.value.host,
              executionContext: request.environmentId === 'E5-remote' ? 'distributed' : 'local',
            },
            sourceHashes: hashes.value,
          },
        }
      : hashes;
  };
}
