import { expect, it } from 'vitest';

import { parseRtcBaselineBoundedInteger } from '../../../baseline/command/rtc-baseline-cli-options.ts';
import {
  rtcBaselineIssue,
  type RtcBaselineResult,
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineAcceptedWorker,
  type RtcBaselineAcceptedWorker,
  runRtcBaselineAcceptedWorker,
  runRtcBaselineAcceptedWorkerCli,
} from '../../../baseline/acceptance/rtc-baseline-worker-protocol.ts';

interface ProtocolTestInput {
  readonly size: number;
}

interface ProtocolTestResult {
  readonly durationMs: number;
  readonly count: number;
  readonly succeeded: boolean;
}

interface DiagnosticTestArguments {
  readonly mode: 'diagnostic';
  readonly out: string;
}

const sampleIds = Array.from(
  { length: 5 },
  (_value, index) =>
    `rtc-b04-protocol-test-fixed-retained-002-${String(index + 1).padStart(3, '0')}`,
);
const workerArguments = [
  '--capture=worker',
  '--baseline-id=20260807-0123456789ab-e1-local',
  '--workload=RTC-B04',
  '--case-id=protocol-test',
  '--input-key=fixed',
  '--intended-phase=retained',
  '--outer-ordinal=2',
  `--sample-ids=${sampleIds.join(',')}`,
  '--rtc-inner-runs=5',
  '--rtc-size=10',
];

function parseProtocolTestWorker(arguments_: readonly string[]) {
  return parseRtcBaselineAcceptedWorker({
    arguments_,
    identity: { workloadId: 'RTC-B04', caseId: 'protocol-test' },
    toInputKey: () => 'fixed',
    capabilityOptionNames: ['rtc-size'],
    parseCapability: (options): RtcBaselineResult<ProtocolTestInput> => {
      const size = parseRtcBaselineBoundedInteger(options['rtc-size'] ?? '', 'rtc-size', 1, 10);
      if (!size.ok) {
        return size;
      }
      return options['rtc-size'] === '10' ? { ok: true, value: { size: size.value } } : {
        ok: false,
        issues: [
          rtcBaselineIssue('$.rtc-size', 'unexpected-worker-input', 'Expected 10.'),
        ],
      };
    },
  });
}

function readProtocolTestWorker(): RtcBaselineAcceptedWorker<ProtocolTestInput> {
  const parsed = parseProtocolTestWorker(workerArguments);
  if (!parsed.ok) {
    throw new Error('Expected protocol test worker.');
  }
  return parsed.value;
}

it('parses exact accepted identity and rejects malformed common worker tokens', () => {
  expect(readProtocolTestWorker()).toEqual({
    mode: 'accepted',
    input: { size: 10 },
    workloadId: 'RTC-B04',
    caseId: 'protocol-test',
    inputKey: 'fixed',
    intendedPhase: 'retained',
    outerOrdinal: 2,
    sampleIds,
  });
  const mutations: readonly [string, string][] = [
    ['--capture=worker', '--capture=wrong'],
    ['--workload=RTC-B04', '--workload=RTC-B03'],
    ['--case-id=protocol-test', '--case-id=wrong'],
    ['--input-key=fixed', '--input-key=wrong'],
    ['--intended-phase=retained', '--intended-phase=wrong'],
    ['--outer-ordinal=2', '--outer-ordinal=02'],
    [`--sample-ids=${sampleIds.join(',')}`, '--sample-ids=wrong'],
    ['--rtc-inner-runs=5', '--rtc-inner-runs=05'],
    ['--rtc-size=10', '--unexpected=10'],
  ];
  for (const [expected, replacement] of mutations) {
    expect(
      parseProtocolTestWorker(
        workerArguments.map((argument) => argument === expected ? replacement : argument),
      ).ok,
    ).toBe(false);
  }
  for (let index = 0; index < workerArguments.length; index += 1) {
    expect(
      parseProtocolTestWorker(workerArguments.filter((_argument, offset) => offset !== index)).ok,
    )
      .toBe(false);
  }
});

it('owns exact sample envelopes, JSON-safe numbers, and causal failure accounting', async () => {
  const worker = readProtocolTestWorker();
  let executions = 0;
  const samples = await runRtcBaselineAcceptedWorker({
    worker,
    run: () => {
      executions += 1;
      return { durationMs: Number.POSITIVE_INFINITY, count: Number.NaN, succeeded: false };
    },
    validate: () => [rtcBaselineIssue('$.rawEvidence.succeeded', 'failed', 'Expected success.')],
    metrics: (result) => [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
    rawEvidence: (result) => result,
  });
  expect(executions).toBe(1);
  expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
    [sampleIds[0], 'failed'],
    ...sampleIds.slice(1).map((sampleId) => [sampleId, 'not-run']),
  ]);
  expect(samples[0]).toMatchObject({
    schema: 'rallar.rtc-baseline.sample.v1',
    evidenceClass: 'synthetic-path',
    metrics: [],
    rawEvidence: { durationMs: null, count: null, succeeded: false },
    rawReferences: [],
    runtimeObservation: null,
  });
  expect(samples.slice(1).map((sample) => sample.issues[0])).toEqual(
    sampleIds.slice(1).map(() => ({
      path: '$.rawEvidence',
      code: 'causal-not-run',
      message: sampleIds[0],
    })),
  );
});

it('dispatches only accepted CLI workers and serializes their samples', async () => {
  const outputs: string[] = [];
  const accepted = await runRtcBaselineAcceptedWorkerCli({
    parsed: readProtocolTestWorker(),
    runAccepted: () => Promise.resolve([]),
    writeOutput: (output) => outputs.push(output),
  });
  expect(accepted).toEqual({ handled: true });
  expect(outputs).toEqual(['[]']);

  const diagnostic: DiagnosticTestArguments = { mode: 'diagnostic', out: 'result.json' };
  const notAccepted = await runRtcBaselineAcceptedWorkerCli({
    parsed: diagnostic,
    runAccepted: () =>
      Promise.reject(
        new Error('Diagnostic input must not run accepted samples.'),
      ),
    writeOutput: (output) => outputs.push(output),
  });
  expect(notAccepted).toEqual({ handled: false, diagnostic });
  expect(outputs).toEqual(['[]']);
});
