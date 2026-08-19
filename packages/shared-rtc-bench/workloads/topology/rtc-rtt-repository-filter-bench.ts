import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { validateRtcRttMeasurement } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import { RTC_RTT_LATEST_NAMESPACE } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';

import { SyntheticRtcRttRuntimeStateRepository } from './synthetic-rtc-rtt-runtime-state-repository.ts';

import {
  rtcBaselineIssue,
  type RtcBaselineSampleDto,
  type RtcBaselineSampleIdentityDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

export interface RtcRttRepositoryFilterInput {
  readonly roomSessions: number;
  readonly globalMeasurements: number;
}

export interface RtcRttRepositoryFilterDependencies {
  readonly runtimeRepository: SyntheticRtcRttRuntimeStateRepository;
  readonly clock: Readonly<{
    nowEpochMs: () => number;
    monotonicNow: () => number;
  }>;
}

export interface RtcRttRepositoryFilterResult {
  readonly durationMs: number;
  readonly targetPairIdentities: readonly string[];
  readonly foreignPairIdentities: readonly string[];
  readonly returnedPairIdentities: readonly string[];
  readonly repositoryCounts: Readonly<{ before: number; after: number }>;
}

interface RtcRttRepositoryFilterAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: RtcRttRepositoryFilterInput & Readonly<{ runs: number }>;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

interface MeasurementPairs {
  readonly target: readonly RttMeasurementInfo[];
  readonly foreign: readonly RttMeasurementInfo[];
}

const acceptedNames = `capture baseline-id workload case-id input-key intended-phase outer-ordinal
sample-ids rtc-global-measurements rtc-inner-runs rtc-room-sessions`.split(/\s+/);

export function parseRtcRttRepositoryFilterArguments(arguments_: readonly string[]) {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedNames : ['room-sessions', 'global-measurements', 'runs', 'out'],
  );
  if (!parsed.ok) {
    return parsed;
  }
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcRttRepositoryFilter(
  input: RtcRttRepositoryFilterInput,
  dependencies: RtcRttRepositoryFilterDependencies,
): Promise<RtcRttRepositoryFilterResult> {
  const repository = new RtcRttRepository(dependencies.runtimeRepository, {
    now: dependencies.clock.nowEpochMs,
  });
  const roomSessionIds = createSessionIds(input.roomSessions);
  const pairs = prepopulateRepository(input, dependencies, repository);
  const before = dependencies.runtimeRepository.data.size;
  const startedAt = dependencies.clock.monotonicNow();
  const returned = await repository.listMeasurementsForSessionIds(roomSessionIds);
  return {
    durationMs: dependencies.clock.monotonicNow() - startedAt,
    targetPairIdentities: pairs.target.map(toPairIdentity),
    foreignPairIdentities: pairs.foreign.map(toPairIdentity),
    returnedPairIdentities: returned.map(toPairIdentity),
    repositoryCounts: { before, after: dependencies.runtimeRepository.data.size },
  };
}

export async function runRtcRttRepositoryFilterAcceptedSamples(input: {
  readonly worker: RtcRttRepositoryFilterAcceptedArguments;
  readonly run: () => Promise<RtcRttRepositoryFilterResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B03',
      caseId: 'rtt-repository-filter',
      inputKey:
        `room-${input.worker.input.roomSessions}-` +
        `global-${input.worker.input.globalMeasurements}`,
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) => createSample(identity, result, issues),
  });
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
  const roomValue = options['room-sessions'] ?? '30';
  const globalValue = options['global-measurements'] ?? '100000';
  const roomSessions = parseRtcBaselineBoundedInteger(roomValue, 'room-sessions', 2, 30);
  const globalMeasurements = parseRtcBaselineBoundedInteger(
    globalValue,
    'global-measurements',
    1,
    100000,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const out = options.out ?? 'tmp/perf/results/rtc-rtt-repository-filter.json';
  const issues = [
    ...(!roomSessions.ok ? roomSessions.issues : []),
    ...(!globalMeasurements.ok ? globalMeasurements.issues : []),
    ...(!runs.ok ? runs.issues : []),
  ];
  const tooSmall =
    roomSessions.ok &&
    globalMeasurements.ok &&
    pairCount(roomSessions.value) > globalMeasurements.value;
  if (tooSmall) {
    issues.push(rtcBaselineIssue('$.global-measurements', 'invalid-diagnostic-input', 'Small.'));
  }
  if (!isDiagnosticOutput(out)) {
    issues.push(rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Invalid result path.'));
  }
  const input = {
    roomSessions: roomSessions.ok ? roomSessions.value : 2,
    globalMeasurements: globalMeasurements.ok ? globalMeasurements.value : 1,
    runs: runs.ok ? runs.value : 1,
  };
  return issues.length > 0
    ? { ok: false as const, issues }
    : { ok: true as const, value: { mode: 'diagnostic' as const, input, out } };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
  const roomValue = options['rtc-room-sessions'] ?? '';
  const globalValue = options['rtc-global-measurements'] ?? '';
  const outerValue = options['outer-ordinal'] ?? '';
  const roomSessions = parseRtcBaselineBoundedInteger(roomValue, 'rtc-room-sessions', 5, 30);
  const globalMeasurements = parseRtcBaselineBoundedInteger(
    globalValue,
    'rtc-global-measurements',
    1000,
    100000,
  );
  const outer = parseRtcBaselineBoundedInteger(outerValue, 'outer-ordinal', 1, 999);
  const issues = [
    ...(!roomSessions.ok ? roomSessions.issues : []),
    ...(!globalMeasurements.ok ? globalMeasurements.issues : []),
    ...(!outer.ok ? outer.issues : []),
  ];
  if (roomSessions.ok && ![5, 30].includes(roomSessions.value)) {
    issues.push(rtcBaselineIssue('$.rtc-room-sessions', 'unexpected-worker-input', 'Invalid.'));
  }
  if (globalMeasurements.ok && ![1000, 10000, 100000].includes(globalMeasurements.value)) {
    issues.push(
      rtcBaselineIssue('$.rtc-global-measurements', 'unexpected-worker-input', 'Invalid.'),
    );
  }
  issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
  const roomCount = roomSessions.ok ? roomSessions.value : 5;
  const globalCount = globalMeasurements.ok ? globalMeasurements.value : 1000;
  const inputKey = `room-${roomCount}-global-${globalCount}`;
  const expected = {
    capture: 'worker',
    workload: 'RTC-B03',
    'case-id': 'rtt-repository-filter',
    'input-key': inputKey,
    'rtc-global-measurements': String(globalCount),
    'rtc-inner-runs': '5',
    'rtc-room-sessions': String(roomCount),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (options[name] !== value) {
      issues.push(rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`));
    }
  }
  const phase = options['intended-phase'];
  if (phase !== 'warmup' && phase !== 'retained') {
    issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
  }
  const intendedPhase: 'warmup' | 'retained' = phase === 'warmup' ? phase : 'retained';
  const ordinal = outer.ok ? outer.value : 0;
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const expectedIds = createExpectedSampleIds(inputKey, intendedPhase, ordinal);
  if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
    issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
  }
  return issues.length > 0
    ? { ok: false as const, issues }
    : {
        ok: true as const,
        value: {
          mode: 'accepted' as const,
          input: { roomSessions: roomCount, globalMeasurements: globalCount, runs: 5 },
          intendedPhase,
          outerOrdinal: ordinal,
          sampleIds,
        },
      };
}

function prepopulateRepository(
  input: RtcRttRepositoryFilterInput,
  dependencies: RtcRttRepositoryFilterDependencies,
  repository: RtcRttRepository,
) {
  if (dependencies.runtimeRepository.data.size !== 0) {
    throw new Error('Expected an empty explicit fake repository.');
  }
  const pairs = createMeasurementPairs(input);
  const expireAtTimestamp = dependencies.clock.nowEpochMs() + 60_000;
  for (const measurement of [...pairs.target, ...pairs.foreign]) {
    validateRtcRttMeasurement(measurement);
    const key = repository.measurementKey(measurement.sessionIdFrom, measurement.sessionIdTo);
    dependencies.runtimeRepository.data.set(`${RTC_RTT_LATEST_NAMESPACE}::${key}`, {
      key,
      value: JSON.stringify(measurement),
      expireAtTimestamp,
      updatedTimestamp: '2026-08-11T00:00:00.000Z',
      revision: 0,
    });
  }
  return pairs;
}

function createMeasurementPairs(input: RtcRttRepositoryFilterInput): MeasurementPairs {
  let globalSessionCount = input.roomSessions;
  while (pairCount(globalSessionCount) < input.globalMeasurements) {
    globalSessionCount += 1;
  }
  const sessionIds = createSessionIds(globalSessionCount);
  const target: RttMeasurementInfo[] = [];
  const foreign: RttMeasurementInfo[] = [];
  const foreignCount = input.globalMeasurements - pairCount(input.roomSessions);
  let version = 0;
  outer: for (let fromIndex = 0; fromIndex < sessionIds.length; fromIndex += 1) {
    for (let toIndex = fromIndex + 1; toIndex < sessionIds.length; toIndex += 1) {
      version += 1;
      const measurement: RttMeasurementInfo = {
        sessionIdFrom: sessionIds[fromIndex],
        sessionIdTo: sessionIds[toIndex],
        rttMs: 5 + ((fromIndex * 31 + toIndex * 17) % 96),
        createdAtEpochMs: version,
        version,
      };
      if (toIndex < input.roomSessions) {
        target.push(measurement);
      } else if (foreign.length < foreignCount) {
        foreign.push(measurement);
      }
      if (target.length === pairCount(input.roomSessions) && foreign.length === foreignCount) {
        break outer;
      }
    }
  }
  return { target, foreign };
}

function createExpectedSampleIds(
  inputKey: string,
  phase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix =
    `rtc-b03-rtt-repository-filter-${inputKey}-${phase}-` + String(outerOrdinal).padStart(3, '0');
  return Array.from({ length: 5 }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
}

function createSample(
  identity: RtcBaselineSampleIdentityDto,
  result: RtcRttRepositoryFilterResult | null,
  issues: RtcBaselineSampleDto['issues'],
): RtcBaselineSampleDto {
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
    evidenceClass: 'synthetic-path',
    metrics:
      result === null ? [] : [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
    rawEvidence:
      result === null
        ? null
        : {
            durationMs: result.durationMs,
            targetPairIdentities: [...result.targetPairIdentities],
            foreignPairIdentities: [...result.foreignPairIdentities],
            returnedPairIdentities: [...result.returnedPairIdentities],
            repositoryCounts: { ...result.repositoryCounts },
          },
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function validateResult(input: RtcRttRepositoryFilterInput, result: RtcRttRepositoryFilterResult) {
  const expected = createMeasurementPairs(input);
  const expectedTargets = expected.target.map(toPairIdentity);
  const expectedForeign = expected.foreign.map(toPairIdentity);
  return JSON.stringify(result.targetPairIdentities) === JSON.stringify(expectedTargets) &&
    JSON.stringify(result.foreignPairIdentities) === JSON.stringify(expectedForeign) &&
    JSON.stringify(result.returnedPairIdentities) === JSON.stringify(expectedTargets) &&
    result.repositoryCounts.before === input.globalMeasurements &&
    result.repositoryCounts.after === input.globalMeasurements
    ? []
    : [rtcBaselineIssue('$.rawEvidence', 'repository-filter-mismatch', 'Unexpected filtering.')];
}

function toPairIdentity(measurement: RttMeasurementInfo): string {
  return `${measurement.sessionIdFrom}::${measurement.sessionIdTo}`;
}

function createSessionIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `session-${String(index).padStart(3, '0')}`);
}

function pairCount(sessions: number): number {
  return (sessions * (sessions - 1)) / 2;
}

function isDiagnosticOutput(out: string): boolean {
  return (
    out.startsWith('tmp/perf/results/') &&
    !out.includes('\\') &&
    out.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
  );
}

function createDependencies(): RtcRttRepositoryFilterDependencies {
  return {
    runtimeRepository: new SyntheticRtcRttRuntimeStateRepository(),
    clock: { nowEpochMs: () => 1_700_000_000_000, monotonicNow: () => performance.now() },
  };
}

async function main(): Promise<void> {
  const parsed = parseRtcRttRepositoryFilterArguments(Deno.args);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  if (parsed.value.mode === 'accepted') {
    const samples = await runRtcRttRepositoryFilterAcceptedSamples({
      worker: parsed.value,
      run: () => runRtcRttRepositoryFilter(parsed.value.input, createDependencies()),
    });
    console.log(JSON.stringify(samples));
    return;
  }
  const results = [];
  for (let run = 1; run <= parsed.value.input.runs; run += 1) {
    const result = await runRtcRttRepositoryFilter(parsed.value.input, createDependencies());
    results.push({ run, ...result });
  }
  await Deno.writeTextFile(
    parsed.value.out,
    `${JSON.stringify({ input: parsed.value.input, results }, null, 2)}\n`,
    { createNew: true },
  );
  console.log(`Wrote ${parsed.value.out}`);
}

if (import.meta.main) {
  await main();
}
