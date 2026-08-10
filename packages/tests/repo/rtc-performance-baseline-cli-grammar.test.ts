import { describe, expect, it } from 'vitest';

import { parseRtcBaselineCommand } from '../../../scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts';

function withoutOption(args: readonly string[], prefix: string) {
  return args.filter((argument) => !argument.startsWith(prefix));
}

function replaceOption(args: readonly string[], prefix: string, replacement: string) {
  if (args.some((argument) => argument.startsWith(prefix))) {
    return args.map((argument) => (argument.startsWith(prefix) ? replacement : argument));
  }
  return [...args, ...replacement.split('|')];
}

function rows(specification: string) {
  return specification
    .trim()
    .split('\n')
    .map((row) => row.split('\t'));
}

function rejected(specification: string) {
  return {
    ok: false,
    issues: rows(specification).map(([path, code, message]) => ({ path, code, message })),
  };
}

const primaryId = '20260807-0123456789ab-e1-local';
const commandInputs = {
  initialize: [
    'initialize',
    `--baseline-id=${primaryId}`,
    '--workloads=RTC-B01',
    '--environment=E1-local',
  ],
  capture: ['capture', `--baseline-id=${primaryId}`, '--workload=RTC-B01'],
  list: [
    'list-external-attempts',
    '--baseline-id=20260807-0123456789ab-e2-browser',
    '--workload=RTC-B05',
    '--format=tsv',
  ],
  browser: [
    'record-browser',
    '--baseline-id=20260807-0123456789ab-e2-browser',
    '--workload=RTC-B05',
    '--case-id=browser-data-channel-lifecycle',
    '--input-key=iterations-25',
    '--intended-phase=retained',
    '--outer-ordinal=1',
    '--producer-exit-status=0',
    '--raw-result=artifacts/staging/result.json',
  ],
  external: [
    'record-external',
    '--baseline-id=20260807-0123456789ab-e3-memory',
    '--workload=RTC-B06',
    '--case-id=default',
    '--input-key=e3-memory-default',
    '--intended-phase=retained',
    '--outer-ordinal=1',
    '--producer-exit-status=0',
    '--raw-result=artifacts/staging/result.json',
  ],
  cohort: [
    'record-external-cohort',
    '--baseline-id=20260807-0123456789ab-e3-memory',
    '--workload=RTC-B06',
    '--cohort-id=rtc-b06-e3-default',
    '--producer-exit-status=0',
    '--raw-result=artifacts/staging/cohort.json',
  ],
  repeat: ['repeat-required', `--baseline-id=${primaryId}`, '--format=workload-csv'],
  compare: [
    'compare-paired',
    `--baseline-id=${primaryId}`,
    '--comparison-baseline-id=20260808-fedcba987654-e1-local',
    '--comparison-cohort-id=20260808-fedcba987654-e1-local',
    `--primary-cohort-id=${primaryId}`,
    '--workload=RTC-B01',
  ],
  validate: ['validate', `--baseline-id=${primaryId}`],
  finalize: ['finalize', `--baseline-id=${primaryId}`],
} as const;

describe('RTC baseline CLI grammar', () => {
  it.each([
    [
      commandInputs.initialize,
      {
        kind: 'initialize',
        baselineId: primaryId,
        workloadIds: ['RTC-B01'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 1,
        repeatOf: null,
        conditionalEnvironmentDecision: null,
      },
    ],
    [commandInputs.capture, { kind: 'capture', baselineId: primaryId, workloadId: 'RTC-B01' }],
    [
      commandInputs.list,
      {
        kind: 'list-external-attempts',
        baselineId: '20260807-0123456789ab-e2-browser',
        workloadId: 'RTC-B05',
        format: 'tsv',
      },
    ],
    [
      commandInputs.browser,
      {
        kind: 'record-browser',
        baselineId: '20260807-0123456789ab-e2-browser',
        locator: {
          workloadId: 'RTC-B05',
          caseId: 'browser-data-channel-lifecycle',
          inputKey: 'iterations-25',
          intendedPhase: 'retained',
          outerOrdinal: 1,
        },
        producerExitStatus: 0,
        rawResultRelativePath: 'artifacts/staging/result.json',
      },
    ],
    [
      commandInputs.external,
      {
        kind: 'record-external',
        baselineId: '20260807-0123456789ab-e3-memory',
        locator: {
          workloadId: 'RTC-B06',
          caseId: 'default',
          inputKey: 'e3-memory-default',
          intendedPhase: 'retained',
          outerOrdinal: 1,
        },
        producerExitStatus: 0,
        rawResultRelativePath: 'artifacts/staging/result.json',
      },
    ],
    [
      commandInputs.cohort,
      {
        kind: 'record-external-cohort',
        baselineId: '20260807-0123456789ab-e3-memory',
        workloadId: 'RTC-B06',
        cohortId: 'rtc-b06-e3-default',
        producerExitStatus: 0,
        rawResultRelativePath: 'artifacts/staging/cohort.json',
      },
    ],
    [
      commandInputs.repeat,
      { kind: 'repeat-required', baselineId: primaryId, format: 'workload-csv' },
    ],
    [
      commandInputs.compare,
      {
        kind: 'compare-paired',
        primaryBaselineId: primaryId,
        candidateBaselineId: '20260808-fedcba987654-e1-local',
        primaryComparisonCohortId: primaryId,
        candidateComparisonCohortId: '20260808-fedcba987654-e1-local',
        workloadId: 'RTC-B01',
      },
    ],
    [commandInputs.validate, { kind: 'validate', baselineId: primaryId }],
    [commandInputs.finalize, { kind: 'finalize', baselineId: primaryId }],
  ])('decodes one of the ten exact commands', (args, value) => {
    expect(parseRtcBaselineCommand(args)).toEqual({ ok: true, value });
  });

  it.each([
    ['--workloads=', `$.workloads\tempty-workloads\tOption --workloads must be nonempty.`],
    [
      '--workloads=RTC-B01,RTC-B01',
      `$.workloads[1]\tduplicate-workload\tWorkload RTC-B01 appears more than once.`,
    ],
    [
      '--workloads=RTC-B07',
      `$.workloads[0]\tunsupported-workload\tWorkload RTC-B07 is not in the frozen catalog.`,
    ],
  ])('rejects malformed plural workload input %s', (workloads, issues) => {
    expect(
      parseRtcBaselineCommand(replaceOption(commandInputs.initialize, '--workloads=', workloads)),
    ).toEqual(rejected(issues));
  });

  it('decodes the exact repeat matrix and rejects caller-supplied summary hashes', () => {
    expect(
      parseRtcBaselineCommand([
        'initialize',
        '--baseline-id=20260807-0123456789ab-e1-local-repeat-01',
        '--workloads=RTC-B03,RTC-B01',
        '--environment=E1-local',
        `--repeat-of=${primaryId}`,
        '--retained-sample-multiplier=2',
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: 'initialize',
        baselineId: '20260807-0123456789ab-e1-local-repeat-01',
        workloadIds: ['RTC-B03', 'RTC-B01'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 2,
        repeatOf: primaryId,
        conditionalEnvironmentDecision: null,
      },
    });
    expect(
      parseRtcBaselineCommand([...commandInputs.initialize, '--primary-summary-sha256=x']),
    ).toEqual(
      rejected(`
$.args[4]	unsupported-option	Option --primary-summary-sha256 is not supported by initialize.
`),
    );
  });

  it.each(
    rows(`
--conditional-environment=E4-pg\t$.conditional-environment-decision~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.|$.conditional-environment-reason~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
--conditional-environment-decision=required\t$.conditional-environment~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.|$.conditional-environment-reason~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
--conditional-environment-reason=why\t$.conditional-environment~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.|$.conditional-environment-decision~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
--conditional-environment=E4-pg,--conditional-environment-decision=required\t$.conditional-environment-reason~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
--conditional-environment=E4-pg,--conditional-environment-reason=why\t$.conditional-environment-decision~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
--conditional-environment-decision=required,--conditional-environment-reason=why\t$.conditional-environment~conditional-option-matrix~Conditional environment, decision, and reason options are all-or-none.
`),
  )('rejects an incomplete initialize conditional matrix', (suffix, issues) => {
    expect(parseRtcBaselineCommand([...commandInputs.initialize, ...suffix.split(',')])).toEqual(
      rejected(issues.replaceAll('|', '\n').replaceAll('~', '\t')),
    );
  });

  it.each(
    rows(`
capture\t--conditional-environment=E4-pg\t$.args[3]\tOption --conditional-environment is not supported by capture.
list\t--conditional-environment=E4-pg\t$.args[4]\tOption --conditional-environment is not supported by list-external-attempts.
browser\t--conditional-environment=E4-pg\t$.args[9]\tOption --conditional-environment is not supported by record-browser.
external\t--conditional-environment=E4-pg\t$.args[9]\tOption --conditional-environment is not supported by record-external.
cohort\t--conditional-environment=E4-pg\t$.args[6]\tOption --conditional-environment is not supported by record-external-cohort.
repeat\t--conditional-environment=E4-pg\t$.args[3]\tOption --conditional-environment is not supported by repeat-required.
compare\t--conditional-environment=E4-pg\t$.args[6]\tOption --conditional-environment is not supported by compare-paired.
validate\t--conditional-environment=E4-pg\t$.args[2]\tOption --conditional-environment is not supported by validate.
finalize\t--conditional-environment=E4-pg\t$.args[2]\tOption --conditional-environment is not supported by finalize.
capture\t--workloads=RTC-B01\t$.args[3]\tOption --workloads is not supported by capture.
list\t--workloads=RTC-B01\t$.args[4]\tOption --workloads is not supported by list-external-attempts.
browser\t--workloads=RTC-B01\t$.args[9]\tOption --workloads is not supported by record-browser.
external\t--workloads=RTC-B01\t$.args[9]\tOption --workloads is not supported by record-external.
cohort\t--workloads=RTC-B01\t$.args[6]\tOption --workloads is not supported by record-external-cohort.
repeat\t--workloads=RTC-B01\t$.args[3]\tOption --workloads is not supported by repeat-required.
compare\t--workloads=RTC-B01\t$.args[6]\tOption --workloads is not supported by compare-paired.
validate\t--workloads=RTC-B01\t$.args[2]\tOption --workloads is not supported by validate.
finalize\t--workloads=RTC-B01\t$.args[2]\tOption --workloads is not supported by finalize.
initialize\t--workload=RTC-B01\t$.args[4]\tOption --workload is not supported by initialize.
repeat\t--workload=RTC-B01\t$.args[3]\tOption --workload is not supported by repeat-required.
validate\t--workload=RTC-B01\t$.args[2]\tOption --workload is not supported by validate.
finalize\t--workload=RTC-B01\t$.args[2]\tOption --workload is not supported by finalize.
capture\t--environment=E1-local\t$.args[3]\tOption --environment is not supported by capture.
capture\t--repeat-of=${primaryId}\t$.args[3]\tOption --repeat-of is not supported by capture.
capture\t--retained-sample-multiplier=2\t$.args[3]\tOption --retained-sample-multiplier is not supported by capture.
capture\t--conditional-environment-decision=required\t$.args[3]\tOption --conditional-environment-decision is not supported by capture.
capture\t--conditional-environment-reason=why\t$.args[3]\tOption --conditional-environment-reason is not supported by capture.
initialize\t--format=tsv\t$.args[4]\tOption --format is not supported by initialize.
cohort\t--case-id=default\t$.args[6]\tOption --case-id is not supported by record-external-cohort.
cohort\t--input-key=e3-memory-default\t$.args[6]\tOption --input-key is not supported by record-external-cohort.
cohort\t--intended-phase=retained\t$.args[6]\tOption --intended-phase is not supported by record-external-cohort.
cohort\t--outer-ordinal=1\t$.args[6]\tOption --outer-ordinal is not supported by record-external-cohort.
validate\t--producer-exit-status=0\t$.args[2]\tOption --producer-exit-status is not supported by validate.
validate\t--raw-result=x\t$.args[2]\tOption --raw-result is not supported by validate.
external\t--cohort-id=cohort\t$.args[9]\tOption --cohort-id is not supported by record-external.
finalize\t--comparison-baseline-id=${primaryId}\t$.args[2]\tOption --comparison-baseline-id is not supported by finalize.
finalize\t--primary-cohort-id=${primaryId}\t$.args[2]\tOption --primary-cohort-id is not supported by finalize.
finalize\t--comparison-cohort-id=${primaryId}\t$.args[2]\tOption --comparison-cohort-id is not supported by finalize.
`),
  )('rejects every option outside its command owner', (kind, option, path, message) => {
    const args = commandInputs[kind as keyof typeof commandInputs];
    expect(parseRtcBaselineCommand([...args, option])).toEqual({
      ok: false,
      issues: [{ path, code: 'unsupported-option', message }],
    });
  });

  it.each(
    rows(`
initialize	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
initialize	--workloads=	$.workloads	missing-option	Required option --workloads is missing.
initialize	--environment=	$.environment	missing-option	Required option --environment is missing.
capture	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
capture	--workload=	$.workload	missing-option	Required option --workload is missing.
list	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
list	--workload=	$.workload	missing-option	Required option --workload is missing.
list	--format=	$.format	missing-option	Required option --format is missing.
browser	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
browser	--workload=	$.workload	missing-option	Required option --workload is missing.
browser	--case-id=	$.case-id	missing-option	Required option --case-id is missing.
browser	--input-key=	$.input-key	missing-option	Required option --input-key is missing.
browser	--intended-phase=	$.intended-phase	missing-option	Required option --intended-phase is missing.
browser	--outer-ordinal=	$.outer-ordinal	missing-option	Required option --outer-ordinal is missing.
browser	--producer-exit-status=	$.producer-exit-status	missing-option	Required option --producer-exit-status is missing.
browser	--raw-result=	$.raw-result	missing-option	Required option --raw-result is missing.
external	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
external	--workload=	$.workload	missing-option	Required option --workload is missing.
external	--case-id=	$.case-id	missing-option	Required option --case-id is missing.
external	--input-key=	$.input-key	missing-option	Required option --input-key is missing.
external	--intended-phase=	$.intended-phase	missing-option	Required option --intended-phase is missing.
external	--outer-ordinal=	$.outer-ordinal	missing-option	Required option --outer-ordinal is missing.
external	--producer-exit-status=	$.producer-exit-status	missing-option	Required option --producer-exit-status is missing.
external	--raw-result=	$.raw-result	missing-option	Required option --raw-result is missing.
cohort	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
cohort	--workload=	$.workload	missing-option	Required option --workload is missing.
cohort	--cohort-id=	$.cohort-id	missing-option	Required option --cohort-id is missing.
cohort	--producer-exit-status=	$.producer-exit-status	missing-option	Required option --producer-exit-status is missing.
cohort	--raw-result=	$.raw-result	missing-option	Required option --raw-result is missing.
repeat	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
repeat	--format=	$.format	missing-option	Required option --format is missing.
compare	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
compare	--comparison-baseline-id=	$.comparison-baseline-id	missing-option	Required option --comparison-baseline-id is missing.
compare	--primary-cohort-id=	$.primary-cohort-id	missing-option	Required option --primary-cohort-id is missing.
compare	--comparison-cohort-id=	$.comparison-cohort-id	missing-option	Required option --comparison-cohort-id is missing.
compare	--workload=	$.workload	missing-option	Required option --workload is missing.
validate	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
finalize	--baseline-id=	$.baseline-id	missing-option	Required option --baseline-id is missing.
`),
  )('rejects every missing required command option', (kind, prefix, path, code, message) => {
    const args = commandInputs[kind as keyof typeof commandInputs];
    expect(parseRtcBaselineCommand(withoutOption(args, prefix))).toEqual({
      ok: false,
      issues: [{ path, code, message }],
    });
  });

  it.each([
    [
      commandInputs.browser,
      `$.args[7]\tunsupported-option\tOption --producer-status is not supported by record-browser.
$.args[8]\tunsupported-option\tOption --staged-path is not supported by record-browser.
$.producer-exit-status\tmissing-option\tRequired option --producer-exit-status is missing.
$.raw-result\tmissing-option\tRequired option --raw-result is missing.`,
    ],
    [
      commandInputs.external,
      `$.args[7]\tunsupported-option\tOption --producer-status is not supported by record-external.
$.args[8]\tunsupported-option\tOption --staged-path is not supported by record-external.
$.producer-exit-status\tmissing-option\tRequired option --producer-exit-status is missing.
$.raw-result\tmissing-option\tRequired option --raw-result is missing.`,
    ],
    [
      commandInputs.cohort,
      `$.args[4]\tunsupported-option\tOption --producer-status is not supported by record-external-cohort.
$.args[5]\tunsupported-option\tOption --staged-path is not supported by record-external-cohort.
$.producer-exit-status\tmissing-option\tRequired option --producer-exit-status is missing.
$.raw-result\tmissing-option\tRequired option --raw-result is missing.`,
    ],
  ])('rejects legacy ingestion aliases', (args, issues) => {
    const canonicalRemoved = withoutOption(
      withoutOption(args, '--producer-exit-status='),
      '--raw-result=',
    );
    expect(
      parseRtcBaselineCommand([...canonicalRemoved, '--producer-status=0', '--staged-path=x']),
    ).toEqual(rejected(issues));
  });

  it.each(
    rows(`
initialize	--baseline-id=	--baseline-id=../escape	$.baseline-id	invalid-baseline-id	Baseline ID does not match the canonical grammar.
initialize	--environment=	--environment=E9	$.environment	unsupported-environment	Environment E9 is not supported.
list	--format=	--format=json	$.format	unsupported-format	Option --format must be tsv.
repeat	--format=	--format=tsv	$.format	unsupported-format	Option --format must be workload-csv.
browser	--intended-phase=	--intended-phase=setup	$.intended-phase	unsupported-phase	Intended phase must be warmup or retained.
browser	--outer-ordinal=	--outer-ordinal=1000	$.outer-ordinal	integer-out-of-range	Option --outer-ordinal must be between 1 and 999.
browser	--producer-exit-status=	--producer-exit-status=256	$.producer-exit-status	integer-out-of-range	Option --producer-exit-status must be between 0 and 255.
initialize	--conditional-environment=	--conditional-environment=E9|--conditional-environment-decision=required|--conditional-environment-reason=needed	$.conditional-environment	unsupported-environment	Environment E9 is not supported.
initialize	--conditional-environment=	--conditional-environment=E4-pg|--conditional-environment-decision=maybe|--conditional-environment-reason=needed	$.conditional-environment-decision	unsupported-decision	Conditional decision must be required or not-required.
initialize	--conditional-environment=	--conditional-environment=E4-pg|--conditional-environment-decision=required|--conditional-environment-reason=   	$.conditional-environment-reason	empty-decision-reason	Conditional environment decisions require a nonempty reason.
initialize	--repeat-of=	--repeat-of=../primary	$.repeat-of	invalid-baseline-id	Baseline ID does not match the canonical grammar.
initialize	--baseline-id=	--baseline-id=20260807-0123456789ab-e1-local-repeat-01	$.repeat-of	missing-repeat-of	A repeat baseline requires --repeat-of.
`),
  )('rejects invalid typed command values', (kind, prefix, replacement, path, code, message) => {
    const args = commandInputs[kind as keyof typeof commandInputs];
    expect(parseRtcBaselineCommand(replaceOption(args, prefix, replacement))).toEqual({
      ok: false,
      issues: [{ path, code, message }],
    });
  });
});
