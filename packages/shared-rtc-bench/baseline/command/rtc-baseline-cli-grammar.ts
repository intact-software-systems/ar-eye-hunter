import type {
  RtcBaselineEnvironmentId,
  RtcBaselineWorkloadId,
} from '../contracts/rtc-baseline-contracts.ts';
import {
  createRtcBaselineCliIssue as issue,
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineCommandOptions,
  readRtcBaselineLiteral,
  readRtcBaselineRequiredOption,
  type RtcBaselineCliIssue,
  type RtcBaselineCliOptions,
} from './rtc-baseline-cli-options.ts';

const workloads = [
  'RTC-B01',
  'RTC-B02',
  'RTC-B03',
  'RTC-B04',
  'RTC-B05',
  'RTC-B06',
] as const satisfies readonly RtcBaselineWorkloadId[];
const environments = [
  'E1-local',
  'E2-browser',
  'E3-memory',
  'E4-pg',
  'E5-remote',
] as const satisfies readonly RtcBaselineEnvironmentId[];
const baselinePattern =
  /^\d{8}-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)(?:-repeat-01)?$/;
const attemptOptions = [
  'baseline-id',
  'workload',
  'case-id',
  'input-key',
  'intended-phase',
  'outer-ordinal',
  'producer-exit-status',
  'raw-result',
] as const;
const baselineOnly = ['baseline-id'] as const;
const allowed = {
  initialize: [
    'baseline-id',
    'workloads',
    'environment',
    'repeat-of',
    'retained-sample-multiplier',
    'conditional-environment',
    'conditional-environment-decision',
    'conditional-environment-reason',
  ],
  capture: ['baseline-id', 'workload'],
  'list-external-attempts': ['baseline-id', 'workload', 'format'],
  'record-browser': attemptOptions,
  'record-external': attemptOptions,
  'record-external-cohort': [
    'baseline-id',
    'workload',
    'cohort-id',
    'producer-exit-status',
    'raw-result',
  ],
  'repeat-required': ['baseline-id', 'format'],
  'compare-paired': [
    'baseline-id',
    'comparison-baseline-id',
    'primary-cohort-id',
    'comparison-cohort-id',
    'workload',
  ],
  validate: baselineOnly,
  finalize: baselineOnly,
} as const;

const required: Record<keyof typeof allowed, readonly string[]> = {
  ...allowed,
  initialize: ['baseline-id', 'workloads', 'environment'],
};

interface AddIssueInput {
  issues: RtcBaselineCliIssue[];
  path: string;
  code: string;
  message: string;
}

function addIssue(input: AddIssueInput) {
  input.issues.push(issue(input.path, input.code, input.message));
}

function singleWorkload(value: string, path = '$.workload') {
  return workloads.some((workload) => workload === value)
    ? null
    : issue(path, 'unsupported-workload', `Workload ${value} is not in the frozen catalog.`);
}

function validateTypedOptions(
  command: keyof typeof allowed,
  options: RtcBaselineCliOptions,
  issues: RtcBaselineCliIssue[],
) {
  for (const name of ['baseline-id', 'comparison-baseline-id'] as const) {
    const value = options[name];
    if (value !== undefined && !baselinePattern.test(value)) {
      issues.push(
        issue(
          `$.${name}`,
          'invalid-baseline-id',
          'Baseline ID does not match the canonical grammar.',
        ),
      );
    }
  }
  if (
    options.environment !== undefined &&
    !environments.some((environment) => environment === options.environment)
  ) {
    addIssue({
      issues,
      path: '$.environment',
      code: 'unsupported-environment',
      message: `Environment ${options.environment} is not supported.`,
    });
  }
  if (
    options['conditional-environment'] !== undefined &&
    !environments.some((environment) => environment === options['conditional-environment'])
  ) {
    addIssue({
      issues,
      path: '$.conditional-environment',
      code: 'unsupported-environment',
      message: `Environment ${options['conditional-environment']} is not supported.`,
    });
  }
  if (
    options['conditional-environment-decision'] !== undefined &&
    options['conditional-environment-decision'] !== 'required' &&
    options['conditional-environment-decision'] !== 'not-required'
  ) {
    addIssue({
      issues,
      path: '$.conditional-environment-decision',
      code: 'unsupported-decision',
      message: 'Conditional decision must be required or not-required.',
    });
  }
  if (options['conditional-environment-reason']?.trim() === '') {
    addIssue({
      issues,
      path: '$.conditional-environment-reason',
      code: 'empty-decision-reason',
      message: 'Conditional environment decisions require a nonempty reason.',
    });
  }
  if (
    options['intended-phase'] !== undefined &&
    options['intended-phase'] !== 'warmup' &&
    options['intended-phase'] !== 'retained'
  ) {
    issues.push(
      issue('$.intended-phase', 'unsupported-phase', 'Intended phase must be warmup or retained.'),
    );
  }
  const expectedFormat = command === 'list-external-attempts' ? 'tsv' : 'workload-csv';
  if (options.format !== undefined && options.format !== expectedFormat) {
    issues.push(
      issue('$.format', 'unsupported-format', `Option --format must be ${expectedFormat}.`),
    );
  }
  if (options['repeat-of'] !== undefined && !baselinePattern.test(options['repeat-of'])) {
    issues.push(
      issue(
        '$.repeat-of',
        'invalid-baseline-id',
        'Baseline ID does not match the canonical grammar.',
      ),
    );
  }
  if (command === 'initialize' && options['baseline-id']?.endsWith('-repeat-01')) {
    if (options['repeat-of'] === undefined) {
      issues.push(
        issue('$.repeat-of', 'missing-repeat-of', 'A repeat baseline requires --repeat-of.'),
      );
    }
  }
}

function parseInitialize(options: RtcBaselineCliOptions, issues: RtcBaselineCliIssue[]) {
  const workloadIds: RtcBaselineWorkloadId[] = [];
  if (Object.hasOwn(options, 'workloads')) {
    const values = options.workloads!.split(',');
    if (options.workloads === '') {
      issues.push(issue('$.workloads', 'empty-workloads', 'Option --workloads must be nonempty.'));
    } else {
      values.forEach((workloadId, index) => {
        const first = values.indexOf(workloadId);
        if (first !== index) {
          issues.push(
            issue(
              `$.workloads[${index}]`,
              'duplicate-workload',
              `Workload ${workloadId} appears more than once.`,
            ),
          );
        } else {
          const unsupported = singleWorkload(workloadId, `$.workloads[${index}]`);
          if (unsupported) issues.push(unsupported);
          else workloadIds.push(readRtcBaselineLiteral(workloadId, workloads));
        }
      });
    }
  }
  const conditionalNames = [
    'conditional-environment',
    'conditional-environment-decision',
    'conditional-environment-reason',
  ];
  const supplied = conditionalNames.filter((name) => Object.hasOwn(options, name));
  if (supplied.length > 0 && supplied.length < conditionalNames.length) {
    conditionalNames
      .filter((name) => !Object.hasOwn(options, name))
      .forEach((name) =>
        issues.push(
          issue(
            `$.${name}`,
            'conditional-option-matrix',
            'Conditional environment, decision, and reason options are all-or-none.',
          ),
        ),
      );
  }
  let multiplier = 1;
  if (options['retained-sample-multiplier'] !== undefined) {
    const parsed = parseRtcBaselineBoundedInteger(
      options['retained-sample-multiplier'],
      'retained-sample-multiplier',
      1,
      2,
    );
    if (parsed.ok) multiplier = parsed.value;
    else issues.push(...parsed.issues);
  }
  return {
    kind: 'initialize' as const,
    baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
    workloadIds,
    environmentId: readRtcBaselineLiteral(options.environment, environments),
    retainedSampleMultiplier: multiplier,
    repeatOf: options['repeat-of'] ?? null,
    conditionalEnvironmentDecision:
      supplied.length === 3
        ? {
            environmentId: readRtcBaselineLiteral(options['conditional-environment'], environments),
            decision: readRtcBaselineLiteral(options['conditional-environment-decision'], [
              'required',
              'not-required',
            ]),
            reason: readRtcBaselineRequiredOption(options['conditional-environment-reason']),
          }
        : null,
  };
}

function parseAttempt(
  command: 'record-browser' | 'record-external',
  options: RtcBaselineCliOptions,
  issues: RtcBaselineCliIssue[],
) {
  const outer = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const status = parseRtcBaselineBoundedInteger(
    options['producer-exit-status'] ?? '',
    'producer-exit-status',
    0,
    255,
  );
  if (options['outer-ordinal'] !== undefined && !outer.ok) issues.push(...outer.issues);
  if (options['producer-exit-status'] !== undefined && !status.ok) issues.push(...status.issues);
  return {
    kind: command,
    baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
    locator: {
      workloadId: readRtcBaselineLiteral(options.workload, workloads),
      caseId: readRtcBaselineRequiredOption(options['case-id']),
      inputKey: readRtcBaselineRequiredOption(options['input-key']),
      intendedPhase: readRtcBaselineLiteral(options['intended-phase'], ['warmup', 'retained']),
      outerOrdinal: outer.ok ? outer.value : 0,
    },
    producerExitStatus: status.ok ? status.value : 0,
    rawResultRelativePath: readRtcBaselineRequiredOption(options['raw-result']),
  };
}

function buildCommand(
  name: keyof typeof allowed,
  options: RtcBaselineCliOptions,
  issues: RtcBaselineCliIssue[],
) {
  if (name === 'initialize') return parseInitialize(options, issues);
  if (name === 'capture') {
    return {
      kind: name,
      baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
      workloadId: readRtcBaselineLiteral(options.workload, workloads),
    };
  }
  if (name === 'list-external-attempts') {
    return {
      kind: name,
      baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
      workloadId: readRtcBaselineLiteral(options.workload, workloads),
      format: 'tsv' as const,
    };
  }
  if (name === 'record-browser' || name === 'record-external') {
    return parseAttempt(name, options, issues);
  }
  if (name === 'record-external-cohort') {
    const status = parseRtcBaselineBoundedInteger(
      options['producer-exit-status'] ?? '',
      'producer-exit-status',
      0,
      255,
    );
    if (options['producer-exit-status'] !== undefined && !status.ok) issues.push(...status.issues);
    return {
      kind: name,
      baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
      workloadId: readRtcBaselineLiteral(options.workload, workloads),
      cohortId: readRtcBaselineRequiredOption(options['cohort-id']),
      producerExitStatus: status.ok ? status.value : 0,
      rawResultRelativePath: readRtcBaselineRequiredOption(options['raw-result']),
    };
  }
  if (name === 'repeat-required') {
    return {
      kind: name,
      baselineId: readRtcBaselineRequiredOption(options['baseline-id']),
      format: 'workload-csv' as const,
    };
  }
  if (name === 'compare-paired') {
    return {
      kind: name,
      primaryBaselineId: readRtcBaselineRequiredOption(options['baseline-id']),
      candidateBaselineId: readRtcBaselineRequiredOption(options['comparison-baseline-id']),
      primaryComparisonCohortId: readRtcBaselineRequiredOption(options['primary-cohort-id']),
      candidateComparisonCohortId: readRtcBaselineRequiredOption(options['comparison-cohort-id']),
      workloadId: readRtcBaselineLiteral(options.workload, workloads),
    };
  }
  return { kind: name, baselineId: readRtcBaselineRequiredOption(options['baseline-id']) };
}
export type RtcBaselineParsedCommand = ReturnType<typeof buildCommand>;
export function parseRtcBaselineCommand(args: readonly string[]) {
  const command = args[0];
  if (!command || !Object.hasOwn(allowed, command)) {
    return {
      ok: false as const,
      issues: [
        issue(
          '$.args[0]',
          'unknown-subcommand',
          `Unknown RTC baseline subcommand ${command ?? ''}.`,
        ),
      ],
    };
  }
  const name = command as keyof typeof allowed;
  const { options, issues } = parseRtcBaselineCommandOptions({
    command: name,
    args: args.slice(1),
    allowed,
    required,
  });
  validateTypedOptions(name, options, issues);
  const value = buildCommand(name, options, issues);
  if (options.workload !== undefined) {
    const unsupported = singleWorkload(options.workload);
    if (unsupported) issues.push(unsupported);
  }
  return issues.length > 0 ? { ok: false as const, issues } : { ok: true as const, value };
}
