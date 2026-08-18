import type {
  RtcBaselineJson,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineSampleDto,
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  computeRtcDataChannelBrowserSoakSample,
} from '../../../workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts';

const baselineId = '20260818-0123456789ab-e2-browser';
const scriptPath =
  'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs';
const caseId = 'browser-data-channel-lifecycle';
const inputKey = 'iterations-25';
const expectedEvents = [
  'local-open',
  'remote-open',
  'remote-message',
  'local-close',
  'remote-close',
];

const runtimeObservation: RtcBaselineRuntimeObservationDto = {
  git: {
    headCommit: '0'.repeat(40),
    headTree: '1'.repeat(40),
    ref: 'main',
    clean: true,
  },
  runtime: {
    node: 'v26.7.0',
    npm: '11.19.0',
    deno: '2.9.5',
    playwright: '1.61.1',
    chromium: 'Google Chrome for Testing 149.0.7827.55',
  },
  host: {
    os: 'darwin',
    kernel: '25.6.0',
    architecture: 'aarch64',
    logicalCpuCount: 12,
    cpuModel: 'Apple M2 Max',
    totalMemoryBytes: 103_079_215_104,
    executionContext: 'local',
  },
  timing: {
    startedAtUtc: '2026-08-18T13:57:31.000Z',
    endedAtUtc: '2026-08-18T13:57:32.000Z',
    monotonicDurationMs: 1000,
    monotonicSource: 'performance.now',
  },
  deviations: [],
  sourceHashes: [
    { path: scriptPath, sha256: 'a'.repeat(64), kind: 'source' },
    {
      path: 'apps/rallar-black-box/playwright.config.ts',
      sha256: 'b'.repeat(64),
      kind: 'config',
    },
  ],
  configurationInputs: [],
  resolvedConfiguration: [
    {
      caseKey: { workloadId: 'RTC-B05', caseId, inputKey },
      field: 'iterations',
      value: 25,
      source: 'default',
    },
  ],
  controllerInputs: [
    { name: 'baselineId', value: baselineId, secret: false },
    { name: 'workloadIds', value: 'RTC-B05', secret: false },
    { name: 'environmentId', value: 'E2-browser', secret: false },
  ],
  workerCommand: {
    redactedArgv: { executable: 'node', arguments: [scriptPath] },
    projection: { fixedWorkerFlags: [], configurationFlags: [] },
  },
  allowlistedEnvironment: {},
};

function toIteration(index: number, events: readonly RtcBaselineJson[]) {
  return {
    index,
    iterationId: 'rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001-001-iteration-' +
      String(index).padStart(3, '0'),
    opened: true,
    closed: true,
    messageReceived: true,
    events: [...events],
    localState: 'closed',
    remoteState: 'closed',
    pcAState: 'closed',
    pcBState: 'closed',
    openDurationMs: index + 0.25,
    closeDurationMs: index + 0.5,
    failure: null,
  };
}

function toFirstIteration(
  events: readonly RtcBaselineJson[],
  failure: string | null,
  remoteState: string,
) {
  return {
    ...toIteration(1, events),
    failure,
    remoteState,
  };
}

function toProducerCommand() {
  const relativePath =
    'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001.json';
  return {
    executable: 'node',
    arguments: [
      scriptPath,
      '--capture=raw-evidence',
      '--baseline-id=' + baselineId,
      '--case-id=' + caseId,
      '--input-key=' + inputKey,
      '--intended-phase=warmup',
      '--outer-ordinal=1',
      '--out=' + relativePath,
    ],
  };
}

function toRawEvidence(iterationEvidence: RtcBaselineJson[]) {
  return {
    createdAt: '2026-08-18T13:57:32.000Z',
    identity: {
      baselineId,
      workloadId: 'RTC-B05',
      caseId,
      inputKey,
      intendedPhase: 'warmup',
      outerOrdinal: 1,
    },
    input: { iterations: 25 },
    producerCommand: toProducerCommand(),
    durationMs: 600,
    heap: {
      beforeBytes: 550_000,
      afterBytes: 600_000,
      deltaBytes: 50_000,
    },
    soak: {
      iterations: 25,
      results: iterationEvidence,
      openedCount: 25,
      closedCount: 25,
      messageReceivedCount: 25,
      localErrorCount: 0,
      remoteErrorCount: 0,
    },
  };
}

function createSample(
  firstIterationEvents: readonly RtcBaselineJson[],
  firstIterationFailure: string | null = null,
  firstIterationRemoteState = 'closed',
): RtcBaselineSampleDto {
  const iterationEvidence = [
    toFirstIteration(firstIterationEvents, firstIterationFailure, firstIterationRemoteState),
    ...Array.from({ length: 24 }, (_, index) => toIteration(index + 2, expectedEvents)),
  ];
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity: {
      sampleId: 'rtc-b05-browser-data-channel-lifecycle-iterations-25-warmup-001-001',
      workloadId: 'RTC-B05',
      caseId,
      inputKey,
      intendedPhase: 'warmup',
      outerOrdinal: 1,
      innerOrdinal: 1,
    },
    outcome: 'not-run',
    evidenceClass: 'native-browser',
    metrics: [],
    rawEvidence: toRawEvidence(iterationEvidence),
    rawReferences: [],
    issues: [],
    runtimeObservation,
  };
}

it('accepts duplicate known success callbacks without changing the raw evidence', () => {
  const duplicateRemoteOpenEvents = [
    'local-open',
    'remote-open',
    'remote-open',
    'remote-message',
    'local-close',
    'remote-close',
  ];
  const staged = createSample(duplicateRemoteOpenEvents);
  const rawEvidenceBeforeValidation = structuredClone(staged.rawEvidence);

  const computed = computeRtcDataChannelBrowserSoakSample(staged, baselineId);

  expect(computed.outcome).toBe('passed');
  expect(computed.issues).toEqual([]);
  expect(computed.rawEvidence).toEqual(rawEvidenceBeforeValidation);
});

it.each([
  {
    description: 'a missing expected callback',
    events: ['local-open', 'remote-message', 'local-close', 'remote-close'],
  },
  {
    description: 'an error callback',
    events: [...expectedEvents, 'remote-error'],
  },
  {
    description: 'an unknown callback',
    events: [...expectedEvents, 'negotiation-needed'],
  },
  {
    description: 'a non-string callback value',
    events: [...expectedEvents, null],
  },
])('rejects $description', ({ events }) => {
  const computed = computeRtcDataChannelBrowserSoakSample(createSample(events), baselineId);

  expect(computed.outcome).toBe('failed');
  expect(computed.issues).toContainEqual(
    expect.objectContaining({
      path: '$.soak.results[0].events',
      code: 'iteration-error',
    }),
  );
});

it('rejects a recorded iteration failure even when all expected callbacks occurred', () => {
  const computed = computeRtcDataChannelBrowserSoakSample(
    createSample(expectedEvents, 'remote channel failed'),
    baselineId,
  );

  expect(computed.outcome).toBe('failed');
  expect(computed.issues).toContainEqual(
    expect.objectContaining({
      path: '$.soak.results[0].events',
      code: 'iteration-error',
    }),
  );
});

it('rejects incomplete lifecycle cleanup even when all expected callbacks occurred', () => {
  const computed = computeRtcDataChannelBrowserSoakSample(
    createSample(expectedEvents, null, 'closing'),
    baselineId,
  );

  expect(computed.outcome).toBe('failed');
  expect(computed.issues).toContainEqual(
    expect.objectContaining({
      path: '$.soak.results[0]',
      code: 'incomplete-lifecycle-cleanup',
    }),
  );
});
