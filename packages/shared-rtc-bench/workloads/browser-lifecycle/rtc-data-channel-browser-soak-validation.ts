import type {
  RtcBaselineExternalAttemptDto,
  RtcBaselineIssueDto,
  RtcBaselineJson,
  RtcBaselineRuntimeObservationDto,
  RtcBaselineSampleDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { rtcBaselineIssue } from '../../baseline/contracts/rtc-baseline-contracts.ts';

export const RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT = {
  workloadId: 'RTC-B05',
  caseId: 'browser-data-channel-lifecycle',
  inputKey: 'iterations-25',
  environmentId: 'E2-browser',
  iterations: 25,
  scriptPath:
    'packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs',
  playwrightConfigPath: 'apps/rallar-black-box/playwright.config.ts',
} as const;

const baselineIdPattern = /^\d{8}-[0-9a-f]{12}-e2-browser(?:-repeat-01)?$/;
const expectedEvents = [
  'local-close',
  'local-open',
  'remote-close',
  'remote-message',
  'remote-open',
];

function toJsonObject(value: RtcBaselineJson | undefined): Record<string, RtcBaselineJson> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, RtcBaselineJson>)
    : null;
}

function same(
  left: object | string | number | boolean | null | undefined,
  right: object | string | number | boolean | null | undefined,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pad(value: number) {
  return String(value).padStart(3, '0');
}

function acceptedRawRelativePath(intendedPhase: string, outerOrdinal: number) {
  return [
    'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25',
    intendedPhase,
    `${pad(outerOrdinal)}.json`,
  ].join('-');
}

function expectedProducerArguments(baselineId: string, identity: RtcBaselineSampleDto['identity']) {
  return [
    RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.scriptPath,
    '--capture=raw-evidence',
    `--baseline-id=${baselineId}`,
    `--case-id=${RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.caseId}`,
    `--input-key=${RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.inputKey}`,
    `--intended-phase=${identity.intendedPhase}`,
    `--outer-ordinal=${identity.outerOrdinal}`,
    `--out=${acceptedRawRelativePath(identity.intendedPhase, identity.outerOrdinal)}`,
  ];
}

function validateRawIdentity(
  rawEvidence: Record<string, RtcBaselineJson>,
  identity: RtcBaselineSampleDto['identity'],
  baselineId: string,
) {
  const rawIdentity = toJsonObject(rawEvidence.identity);
  if (rawIdentity === null) {
    return [
      rtcBaselineIssue(
        '$.identity',
        'invalid-raw-identity',
        'Raw evidence identity must be an object.',
      ),
    ];
  }
  const expected = {
    workloadId: identity.workloadId,
    caseId: identity.caseId,
    inputKey: identity.inputKey,
    intendedPhase: identity.intendedPhase,
    outerOrdinal: identity.outerOrdinal,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((field) => [field, rawIdentity[field]]),
  );
  const issues: RtcBaselineIssueDto[] = [];
  if (!same(actual, expected)) {
    issues.push(
      rtcBaselineIssue(
        '$.identity',
        'raw-identity-mismatch',
        'Raw identity must match the sample identity.',
      ),
    );
  }
  if (rawIdentity.baselineId !== baselineId) {
    issues.push(
      rtcBaselineIssue(
        '$.identity.baselineId',
        'baseline-id-mismatch',
        'Raw baseline identity must match the trusted record-browser baseline.',
      ),
    );
  } else if (!baselineIdPattern.test(baselineId)) {
    issues.push(
      rtcBaselineIssue(
        '$.identity.baselineId',
        'invalid-baseline-id',
        'Raw baseline identity is invalid.',
      ),
    );
  }
  return issues;
}

function validateProducerCommand(
  rawEvidence: Record<string, RtcBaselineJson>,
  identity: RtcBaselineSampleDto['identity'],
  baselineId: string,
) {
  const producerCommand = toJsonObject(rawEvidence.producerCommand);
  if (producerCommand === null) {
    return [
      rtcBaselineIssue(
        '$.producerCommand',
        'invalid-producer-command',
        'Raw producer command must be complete.',
      ),
    ];
  }
  const valid = producerCommand.executable === 'node' &&
    same(producerCommand.arguments, expectedProducerArguments(baselineId, identity));
  return valid ? [] : [
    rtcBaselineIssue(
      '$.producerCommand',
      'producer-command-mismatch',
      'Raw producer command must match the immutable B05 invocation.',
    ),
  ];
}

function validateHeap(heapValue: RtcBaselineJson | undefined) {
  const heap = toJsonObject(heapValue);
  if (heap === null) {
    return [rtcBaselineIssue('$.heap', 'invalid-heap-metrics', 'Heap metrics must be an object.')];
  }
  const values = [heap.beforeBytes, heap.afterBytes, heap.deltaBytes];
  const heapMetricsAbsent = values.map((value) => value === null).every(Boolean);
  if (heapMetricsAbsent) {
    return [];
  }
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return [
      rtcBaselineIssue(
        '$.heap',
        'incomplete-heap-metrics',
        'Heap metrics must be absent or complete.',
      ),
    ];
  }
  const [beforeBytes, afterBytes, deltaBytes] = values as number[];
  const heapMetricsConsistent = [
    beforeBytes >= 0,
    afterBytes >= 0,
    deltaBytes === afterBytes - beforeBytes,
  ].every(Boolean);
  if (!heapMetricsConsistent) {
    return [
      rtcBaselineIssue(
        '$.heap.deltaBytes',
        'heap-delta-mismatch',
        'Heap delta must equal after minus before.',
      ),
    ];
  }
  return [];
}

function validateIterationTiming(iteration: Record<string, RtcBaselineJson>, index: number) {
  const issues: RtcBaselineIssueDto[] = [];
  if (
    iteration.opened !== true ||
    typeof iteration.openDurationMs !== 'number' ||
    !Number.isFinite(iteration.openDurationMs) ||
    iteration.openDurationMs < 0
  ) {
    issues.push(
      rtcBaselineIssue(
        `$.soak.results[${index}].openDurationMs`,
        'invalid-open-lifecycle',
        'Iteration must open with a nonnegative duration.',
      ),
    );
  }
  if (
    iteration.closed !== true ||
    typeof iteration.closeDurationMs !== 'number' ||
    !Number.isFinite(iteration.closeDurationMs) ||
    iteration.closeDurationMs < 0
  ) {
    issues.push(
      rtcBaselineIssue(
        `$.soak.results[${index}].closeDurationMs`,
        'invalid-close-lifecycle',
        'Iteration must close with a nonnegative duration.',
      ),
    );
  }
  return issues;
}

function validateIterationCleanup(iteration: Record<string, RtcBaselineJson>, index: number) {
  const issues: RtcBaselineIssueDto[] = [];
  if (iteration.messageReceived !== true) {
    issues.push(
      rtcBaselineIssue(
        `$.soak.results[${index}].messageReceived`,
        'message-not-received',
        'Remote channel must receive the sent payload.',
      ),
    );
  }
  const finalStates = [
    iteration.localState,
    iteration.remoteState,
    iteration.pcAState,
    iteration.pcBState,
  ];
  if (!finalStates.every((state) => state === 'closed')) {
    issues.push(
      rtcBaselineIssue(
        `$.soak.results[${index}]`,
        'incomplete-lifecycle-cleanup',
        'Channels and peer connections must finish closed.',
      ),
    );
  }
  const events = Array.isArray(iteration.events) ? iteration.events : [];
  const uniqueEvents = new Set(events);
  const lifecycleEventsComplete = uniqueEvents.size === expectedEvents.length &&
    expectedEvents.every((eventName) => uniqueEvents.has(eventName));
  if (!lifecycleEventsComplete || iteration.failure !== null) {
    issues.push(
      rtcBaselineIssue(
        `$.soak.results[${index}].events`,
        'iteration-error',
        'Iteration recorded an incomplete lifecycle or operation error.',
      ),
    );
  }
  return issues;
}

function validateIteration(
  iterationValue: RtcBaselineJson,
  index: number,
  iterationIdPrefix: string,
) {
  const iteration = toJsonObject(iterationValue);
  if (iteration === null) {
    return [
      rtcBaselineIssue(
        `$.soak.results[${index}]`,
        'invalid-iteration-evidence',
        'Iteration evidence must be an object.',
      ),
    ];
  }
  const expectedId = `${iterationIdPrefix}-iteration-${pad(index + 1)}`;
  const identityIssues = iteration.index === index + 1 && iteration.iterationId === expectedId
    ? []
    : [
      rtcBaselineIssue(
        `$.soak.results[${index}].iterationId`,
        'iteration-identity-mismatch',
        'Iteration identity is not unique and ordered.',
      ),
    ];
  return [
    ...identityIssues,
    ...validateIterationTiming(iteration, index),
    ...validateIterationCleanup(iteration, index),
  ];
}

function validateSoak(rawEvidence: Record<string, RtcBaselineJson>, iterationIdPrefix: string) {
  const soak = toJsonObject(rawEvidence.soak);
  if (soak === null || !Array.isArray(soak.results)) {
    return [rtcBaselineIssue('$.soak', 'invalid-soak-evidence', 'Soak evidence must be complete.')];
  }
  const count = RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.iterations;
  const issues: RtcBaselineIssueDto[] = [];
  if (soak.iterations !== count || soak.results.length !== count) {
    issues.push(
      rtcBaselineIssue(
        '$.soak.results',
        'iteration-count-mismatch',
        'RTC-B05 requires 25 iterations.',
      ),
    );
  }
  const countChecks = [
    ['openedCount', count, 'incomplete-open-count', 'RTC-B05 requires 25 opens.'],
    ['closedCount', count, 'incomplete-close-count', 'RTC-B05 requires 25 closes.'],
    [
      'messageReceivedCount',
      count,
      'incomplete-message-count',
      'RTC-B05 requires 25 received messages.',
    ],
    ['localErrorCount', 0, 'local-error-count', 'RTC-B05 requires zero local errors.'],
    ['remoteErrorCount', 0, 'remote-error-count', 'RTC-B05 requires zero remote errors.'],
  ] as const;
  const countIssues = countChecks
    .filter(([field, expected]) => soak[field] !== expected)
    .map(([field, _expected, code, message]) => rtcBaselineIssue(`$.soak.${field}`, code, message));
  return [
    ...issues,
    ...countIssues,
    ...soak.results.flatMap((iteration, index) =>
      validateIteration(iteration, index, iterationIdPrefix)
    ),
  ];
}

function validateMeasurement(
  rawEvidence: Record<string, RtcBaselineJson>,
  iterationIdPrefix: string,
) {
  const duration = rawEvidence.durationMs;
  const durationIssues = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
    ? []
    : [
      rtcBaselineIssue(
        '$.durationMs',
        'invalid-duration',
        'Soak duration must be nonnegative.',
      ),
    ];
  return [
    ...durationIssues,
    ...validateSoak(rawEvidence, iterationIdPrefix),
    ...validateHeap(rawEvidence.heap),
  ];
}

export function validateRtcDataChannelBrowserSoakRuntimeObservation(
  observation: RtcBaselineRuntimeObservationDto | null,
  baselineId: string,
) {
  if (observation === null) {
    return [
      rtcBaselineIssue(
        '$.runtimeObservation',
        'missing-runtime-observation',
        'B05 requires its initialized runtime observation.',
      ),
    ];
  }
  const contract = RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT;
  const expectedSources = [
    { path: contract.scriptPath, kind: 'source' },
    { path: contract.playwrightConfigPath, kind: 'config' },
  ];
  const sourceIdentities = observation.sourceHashes.map(({ path, kind }) => ({ path, kind }));
  const hashesValid = observation.sourceHashes.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256));
  const expectedConfiguration = [
    {
      caseKey: {
        workloadId: contract.workloadId,
        caseId: contract.caseId,
        inputKey: contract.inputKey,
      },
      field: 'iterations',
      value: contract.iterations,
      source: 'default',
    },
  ];
  const expectedControllers = [
    { name: 'baselineId', value: baselineId, secret: false },
    { name: 'workloadIds', value: contract.workloadId, secret: false },
    { name: 'environmentId', value: contract.environmentId, secret: false },
  ];
  const expectedWorker = {
    redactedArgv: { executable: 'node', arguments: [contract.scriptPath] },
    projection: { fixedWorkerFlags: [], configurationFlags: [] },
  };
  const valid = same(observation.deviations, []) &&
    same(sourceIdentities, expectedSources) &&
    hashesValid &&
    same(observation.configurationInputs, []) &&
    same(observation.resolvedConfiguration, expectedConfiguration) &&
    same(observation.controllerInputs, expectedControllers) &&
    same(observation.workerCommand, expectedWorker);
  return valid ? [] : [
    rtcBaselineIssue(
      '$.runtimeObservation',
      'runtime-observation-mismatch',
      'Runtime observation must match the initialized B05 identity and configuration.',
    ),
  ];
}

function validateRawEvidence(sample: RtcBaselineSampleDto, baselineId: string) {
  const rawEvidence = toJsonObject(sample.rawEvidence);
  if (rawEvidence === null) {
    return [
      rtcBaselineIssue(
        '$.rawEvidence',
        'invalid-raw-evidence',
        'B05 raw evidence must be an object.',
      ),
    ];
  }
  const inputValid = same(rawEvidence.input, {
    iterations: RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.iterations,
  });
  const createdAtValid = typeof rawEvidence.createdAt === 'string' &&
    Number.isFinite(Date.parse(rawEvidence.createdAt));
  return [
    ...validateRawIdentity(rawEvidence, sample.identity, baselineId),
    ...validateProducerCommand(rawEvidence, sample.identity, baselineId),
    ...validateMeasurement(rawEvidence, sample.identity.sampleId),
    ...(!inputValid
      ? [
        rtcBaselineIssue(
          '$.input.iterations',
          'input-mismatch',
          'B05 requires exactly 25 iterations.',
        ),
      ]
      : []),
    ...(!createdAtValid
      ? [
        rtcBaselineIssue(
          '$.createdAt',
          'invalid-created-at',
          'Raw evidence creation time is invalid.',
        ),
      ]
      : []),
    ...validateRtcDataChannelBrowserSoakRuntimeObservation(sample.runtimeObservation, baselineId),
    ...(sample.rawReferences.length === 0 ? [] : [
      rtcBaselineIssue(
        '$.rawReferences',
        'unexpected-raw-reference',
        'B05 stages evidence inline.',
      ),
    ]),
  ];
}

function computeFiniteMetric(
  value: RtcBaselineJson | undefined,
  metric: string,
  unit: string,
): RtcBaselineSampleDto['metrics'] {
  return typeof value === 'number' && Number.isFinite(value) ? [{ metric, unit, value }] : [];
}

function computeIterationMetrics(resultValue: RtcBaselineJson): RtcBaselineSampleDto['metrics'] {
  const result = toJsonObject(resultValue);
  return result === null ? [] : [
    ...computeFiniteMetric(result.openDurationMs, 'openDurationMs', 'ms'),
    ...computeFiniteMetric(result.closeDurationMs, 'closeDurationMs', 'ms'),
  ];
}

function computeHeapMetrics(
  heapValue: RtcBaselineJson | undefined,
): RtcBaselineSampleDto['metrics'] {
  const heap = toJsonObject(heapValue);
  const values = [heap?.beforeBytes, heap?.afterBytes, heap?.deltaBytes];
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? [
      { metric: 'heapBeforeBytes', unit: 'bytes', value: values[0] as number },
      { metric: 'heapAfterBytes', unit: 'bytes', value: values[1] as number },
      { metric: 'heapDeltaBytes', unit: 'bytes', value: values[2] as number },
    ]
    : [];
}

function computeMetrics(rawEvidenceValue: RtcBaselineJson): RtcBaselineSampleDto['metrics'] {
  const rawEvidence = toJsonObject(rawEvidenceValue);
  if (rawEvidence === null) {
    return [];
  }
  const soak = toJsonObject(rawEvidence.soak);
  const results = Array.isArray(soak?.results) ? soak.results : [];
  return [
    ...computeFiniteMetric(rawEvidence.durationMs, 'durationMs', 'ms'),
    ...results.flatMap(computeIterationMetrics),
    ...computeHeapMetrics(rawEvidence.heap),
  ];
}

export function computeRtcDataChannelBrowserSoakSample(
  sample: RtcBaselineSampleDto,
  baselineId: string,
): RtcBaselineSampleDto {
  const issues = validateRawEvidence(sample, baselineId);
  return {
    ...sample,
    outcome: issues.length === 0 ? ('passed' as const) : ('failed' as const),
    metrics: computeMetrics(sample.rawEvidence),
    issues,
  };
}

export function computeRtcDataChannelBrowserSoakAttempt(
  attempt: RtcBaselineExternalAttemptDto,
  baselineId: string,
): RtcBaselineExternalAttemptDto {
  const samples = attempt.samples.map((sample) =>
    computeRtcDataChannelBrowserSoakSample(sample, baselineId)
  );
  return {
    ...attempt,
    sampleOutcomes: samples.map(({ identity, outcome, issues }) => ({ identity, outcome, issues })),
    samples,
    issues: samples.flatMap(({ issues }) => issues),
  };
}
