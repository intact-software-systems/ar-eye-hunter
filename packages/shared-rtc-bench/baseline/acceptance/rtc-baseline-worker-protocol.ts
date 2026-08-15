import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../command/rtc-baseline-cli-options.ts';
import {
  rtcBaselineIssue,
  type RtcBaselineIssueDto,
  type RtcBaselineJson,
  type RtcBaselineResult,
  type RtcBaselineSampleDto,
  type RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineId } from '../contracts/rtc-baseline-validation.ts';
import { runRtcBaselineAcceptedWorkerSamples } from './rtc-baseline-failure-accounting.ts';

export interface RtcBaselineAcceptedWorker<CapabilityInput> {
  readonly mode: 'accepted';
  readonly input: CapabilityInput;
  readonly workloadId: RtcBaselineWorkloadId;
  readonly caseId: string;
  readonly inputKey: string;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

interface ParseRtcBaselineAcceptedWorkerInput<CapabilityInput> {
  readonly arguments_: readonly string[];
  readonly identity: {
    readonly workloadId: RtcBaselineWorkloadId;
    readonly caseId: string;
  };
  readonly toInputKey: (capability: CapabilityInput) => string;
  readonly capabilityOptionNames: readonly string[];
  readonly parseCapability: (
    options: Readonly<Record<string, string>>,
  ) => RtcBaselineResult<CapabilityInput>;
}

interface RtcBaselineWorkerMetric {
  readonly metric: string;
  readonly unit: string;
  readonly value: number;
}

interface RunRtcBaselineAcceptedWorkerInput<CapabilityInput, Result> {
  readonly worker: RtcBaselineAcceptedWorker<CapabilityInput>;
  readonly run: () => Result | Promise<Result>;
  readonly validate: (result: Result) => readonly RtcBaselineIssueDto[];
  readonly metrics: (result: Result) => readonly RtcBaselineWorkerMetric[];
  readonly rawEvidence: (result: Result) => RtcBaselineJson;
}

interface RunRtcBaselineAcceptedWorkerCliInput<
  CapabilityInput,
  Diagnostic extends { readonly mode: 'diagnostic' },
> {
  readonly parsed: RtcBaselineAcceptedWorker<CapabilityInput> | Diagnostic;
  readonly runAccepted: (
    worker: RtcBaselineAcceptedWorker<CapabilityInput>,
  ) => Promise<readonly RtcBaselineSampleDto[]>;
  readonly writeOutput: (output: string) => void;
}

const commonOptionNames = [
  'capture',
  'baseline-id',
  'workload',
  'case-id',
  'input-key',
  'intended-phase',
  'outer-ordinal',
  'sample-ids',
  'rtc-inner-runs',
];

export function parseRtcBaselineAcceptedWorker<CapabilityInput>(
  input: ParseRtcBaselineAcceptedWorkerInput<CapabilityInput>,
): RtcBaselineResult<RtcBaselineAcceptedWorker<CapabilityInput>> {
  const parsed = parseRtcBaselineOneTokenOptions(
    input.arguments_,
    [...commonOptionNames, ...input.capabilityOptionNames],
  );
  if (!parsed.ok) {
    return parsed;
  }
  const capability = input.parseCapability(parsed.value);
  if (!capability.ok) {
    return capability;
  }
  const identity = { ...input.identity, inputKey: input.toInputKey(capability.value) };
  const outerOrdinal = parseRtcBaselineBoundedInteger(
    parsed.value['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const intendedPhase = parsed.value['intended-phase'];
  const sampleIds = (parsed.value['sample-ids'] ?? '').split(',');
  const issues = [
    ...(!outerOrdinal.ok ? outerOrdinal.issues : []),
    ...validateRtcBaselineId(parsed.value['baseline-id'] ?? ''),
    ...validateAcceptedIdentity({
      options: parsed.value,
      identity,
      intendedPhase,
      outerOrdinal,
      sampleIds,
    }),
  ];
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      mode: 'accepted',
      input: capability.value,
      ...identity,
      intendedPhase: intendedPhase as 'warmup' | 'retained',
      outerOrdinal: outerOrdinal.ok ? outerOrdinal.value : 1,
      sampleIds,
    },
  };
}

export function runRtcBaselineAcceptedWorker<CapabilityInput, Result>(
  input: RunRtcBaselineAcceptedWorkerInput<CapabilityInput, Result>,
): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: input.worker,
    run: input.run,
    validate: input.validate,
    createSample: ({ identity, result, issues }) => {
      if (result === null) {
        return createNotRunSample(identity, issues);
      }
      return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: issues.length === 0 ? 'passed' : 'failed',
        evidenceClass: 'synthetic-path',
        metrics: input.metrics(result).filter((metric) =>
          Number.isFinite(metric.value) && metric.value >= 0
        ),
        rawEvidence: normalizeRtcBaselineWorkerJson(input.rawEvidence(result)),
        rawReferences: [],
        issues,
        runtimeObservation: null,
      };
    },
  });
}

export async function runRtcBaselineAcceptedWorkerCli<
  CapabilityInput,
  Diagnostic extends { readonly mode: 'diagnostic' },
>(input: RunRtcBaselineAcceptedWorkerCliInput<CapabilityInput, Diagnostic>): Promise<
  | { readonly handled: true }
  | { readonly handled: false; readonly diagnostic: Diagnostic }
> {
  if (input.parsed.mode !== 'accepted') {
    return { handled: false, diagnostic: input.parsed };
  }
  const samples = await input.runAccepted(input.parsed);
  input.writeOutput(JSON.stringify(samples));
  return { handled: true };
}

interface ValidateAcceptedIdentityInput {
  readonly options: Readonly<Record<string, string>>;
  readonly identity: {
    readonly workloadId: RtcBaselineWorkloadId;
    readonly caseId: string;
    readonly inputKey: string;
  };
  readonly intendedPhase: string | undefined;
  readonly outerOrdinal: RtcBaselineResult<number>;
  readonly sampleIds: readonly string[];
}

function validateAcceptedIdentity(input: ValidateAcceptedIdentityInput): RtcBaselineIssueDto[] {
  const expected = {
    capture: 'worker',
    workload: input.identity.workloadId,
    'case-id': input.identity.caseId,
    'input-key': input.identity.inputKey,
    'rtc-inner-runs': '5',
  };
  const issues = Object.entries(expected)
    .filter(([name, value]) => input.options[name] !== value)
    .map(([name, value]) =>
      rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`)
    );
  const phase = input.intendedPhase === 'warmup' ? 'warmup' : 'retained';
  const ordinal = input.outerOrdinal.ok ? input.outerOrdinal.value : 1;
  return [
    ...issues,
    ...issueUnless(
      input.outerOrdinal.ok && input.options['outer-ordinal'] === String(ordinal),
      '$.outer-ordinal',
      'Expected canonical integer syntax.',
    ),
    ...issueUnless(
      ['warmup', 'retained'].includes(input.intendedPhase ?? ''),
      '$.intended-phase',
      'Invalid phase.',
    ),
    ...issueUnless(
      JSON.stringify(input.sampleIds) ===
        JSON.stringify(createExpectedSampleIds(input.identity, phase, ordinal)),
      '$.sample-ids',
      'Invalid sample IDs.',
    ),
  ];
}

function createExpectedSampleIds(
  identity: ValidateAcceptedIdentityInput['identity'],
  intendedPhase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix = `${identity.workloadId.toLowerCase()}-${identity.caseId}-${identity.inputKey}-` +
    `${intendedPhase}-${String(outerOrdinal).padStart(3, '0')}`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function issueUnless(valid: boolean, path: string, message: string): RtcBaselineIssueDto[] {
  return valid ? [] : [rtcBaselineIssue(path, 'unexpected-worker-input', message)];
}

function createNotRunSample(
  identity: RtcBaselineSampleDto['identity'],
  issues: readonly RtcBaselineIssueDto[],
): RtcBaselineSampleDto {
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: 'not-run',
    evidenceClass: 'synthetic-path',
    metrics: [],
    rawEvidence: null,
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function normalizeRtcBaselineWorkerJson(value: RtcBaselineJson): RtcBaselineJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRtcBaselineWorkerJson);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeRtcBaselineWorkerJson(entry)]),
  );
}
