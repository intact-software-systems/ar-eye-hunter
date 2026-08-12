import { describe, expect, it } from 'vitest';

import {
  encodeRtcBaselineSampleIds,
  encodeRtcBaselineScalar,
  parseRtcBaselineOneTokenOptions,
} from '../../../baseline/command/rtc-baseline-cli-options.ts';

import {
  deriveRtcBaselineWorkerProjection,
  resolveRtcBaselineConfiguration,
  validateRtcBaselineCaptureRequest,
  validateRtcBaselineConditionalEnvironmentDecision,
  validateRtcBaselineId,
  validateRtcBaselineRepeatLink,
  validateRtcBaselineRepeatRequest,
} from '../../../baseline/contracts/rtc-baseline-validation.ts';

describe('RTC baseline core validation', () => {
  it('parses one-token options and rejects duplicate, positional, unsupported, and two-token forms', () => {
    expect(parseRtcBaselineOneTokenOptions(['--one=1'], ['one'])).toEqual({
      ok: true,
      value: { one: '1' },
    });
    expect(
      parseRtcBaselineOneTokenOptions(['--one=1', '--one=2', 'value', '--two', '2'], ['one']),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.args[1]',
          code: 'duplicate-option',
          message: 'Option --one appears more than once.',
        },
        {
          path: '$.args[2]',
          code: 'positional-argument',
          message: 'Positional arguments are not supported.',
        },
        {
          path: '$.args[3]',
          code: 'two-token-option',
          message: 'Options must use one --name=value token.',
        },
        {
          path: '$.args[4]',
          code: 'positional-argument',
          message: 'Positional arguments are not supported.',
        },
      ],
    });
  });

  it('encodes canonical booleans, integers, strings, and comma-joined sample IDs', () => {
    expect([
      encodeRtcBaselineScalar(true),
      encodeRtcBaselineScalar(false),
      encodeRtcBaselineScalar(25),
      encodeRtcBaselineScalar('local'),
    ]).toEqual(['true', 'false', '25', 'local']);
    expect(encodeRtcBaselineSampleIds(['sample-001', 'sample-002'])).toEqual({
      ok: true,
      value: 'sample-001,sample-002',
    });
    expect(encodeRtcBaselineSampleIds(['bad,id'])).toEqual({
      ok: false,
      issues: [
        {
          path: '$.sampleIds[0]',
          code: 'invalid-sample-id-token',
          message: 'Sample IDs may not contain commas.',
        },
      ],
    });
  });

  it.each([
    ['20260807-0123456789ab-e1-local', []],
    ['20260807-0123456789ab-e2-browser-repeat-01', []],
    [
      '2026087-0123456789ab-e1-local',
      [
        {
          path: '$.baselineId',
          code: 'invalid-baseline-id',
          message: 'Baseline ID does not match the canonical grammar.',
        },
      ],
    ],
  ])('validates baseline ID %s', (baselineId, issues) => {
    expect(validateRtcBaselineId(baselineId)).toEqual(issues);
  });

  it('validates workload membership, order, and repeat-subset semantics', () => {
    expect(
      validateRtcBaselineCaptureRequest({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId: '20260807-0123456789ab-e1-local-repeat-01',
        workloadIds: ['RTC-B03', 'RTC-B03', 'RTC-B07'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
      }),
    ).toEqual([
      {
        path: '$.workloadIds[1]',
        code: 'duplicate-workload',
        message: 'Workload RTC-B03 appears more than once.',
      },
      {
        path: '$.workloadIds[2]',
        code: 'unsupported-workload',
        message: 'Workload RTC-B07 is not in the frozen catalog.',
      },
      {
        path: '$.retainedSampleMultiplier',
        code: 'invalid-repeat-multiplier',
        message: 'A repeat baseline requires retained sample multiplier 2.',
      },
      {
        path: '$.repeatLink',
        code: 'missing-repeat-link',
        message: 'A repeat baseline requires an exact primary summary link.',
      },
    ]);
  });

  it('rejects missing, empty, and changed conditional decisions', () => {
    expect(
      validateRtcBaselineConditionalEnvironmentDecision({
        environmentId: 'E4-pg',
        decision: 'required',
        reason: '   ',
      }),
    ).toEqual([
      {
        path: '$.reason',
        code: 'empty-decision-reason',
        message: 'Conditional environment decisions require a nonempty reason.',
      },
    ]);
    expect(
      validateRtcBaselineRepeatLink('20260807-0123456789ab-e1-local-repeat-01', {
        primaryBaselineId: '20260807-ffffffffffff-e1-local',
        primarySummarySha256: 'g'.repeat(64),
      }),
    ).toEqual([
      {
        path: '$.repeatLink.primaryBaselineId',
        code: 'repeat-primary-mismatch',
        message: 'Repeat baseline must link to its exact suffix-free primary baseline.',
      },
      {
        path: '$.repeatLink.primarySummarySha256',
        code: 'invalid-sha256',
        message: 'Expected a lowercase 64-character SHA-256 digest.',
      },
    ]);
  });

  it('resolves CLI then allowlisted environment then default without provenance drift', () => {
    const descriptor = {
      caseKey: {
        workloadId: 'RTC-B06' as const,
        caseId: 'all-scenarios',
        inputKey: 'e3-memory-all-scenarios',
      },
      field: 'allScenarios',
      flag: '--rtc-all-scenarios',
      scalarKind: 'boolean' as const,
      defaultValue: true,
      allowlistedEnvironmentVariable: 'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
      environmentUnsetBehavior: 'reject' as const,
    };
    expect(
      resolveRtcBaselineConfiguration(descriptor, { cliValue: false, environmentValue: '1' }),
    ).toEqual({
      ok: true,
      value: { caseKey: descriptor.caseKey, field: 'allScenarios', value: false, source: 'cli' },
    });
    expect(
      resolveRtcBaselineConfiguration(descriptor, { cliValue: undefined, environmentValue: '1' }),
    ).toEqual({
      ok: true,
      value: {
        caseKey: descriptor.caseKey,
        field: 'allScenarios',
        value: true,
        source: 'environment',
      },
    });
    expect(
      resolveRtcBaselineConfiguration(
        { ...descriptor, defaultValue: false, environmentUnsetBehavior: null },
        { cliValue: undefined, environmentValue: undefined },
      ),
    ).toEqual({
      ok: true,
      value: {
        caseKey: descriptor.caseKey,
        field: 'allScenarios',
        value: false,
        source: 'default',
      },
    });
    expect(
      resolveRtcBaselineConfiguration(descriptor, {
        cliValue: undefined,
        environmentValue: undefined,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.environment.RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
          code: 'missing-required-environment',
          message: 'Required allowlisted environment value is unset.',
        },
      ],
    });
    expect(
      resolveRtcBaselineConfiguration(descriptor, {
        cliValue: undefined,
        environmentValue: 'sometimes',
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.environment.RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
          code: 'invalid-environment-value',
          message: 'Boolean environment values must be 0, 1, false, or true.',
        },
      ],
    });
  });

  it('keeps controller provenance unchanged while deriving worker flags', () => {
    const controllerInputs = [
      { name: 'baselineId', value: '20260807-0123456789ab-e1-local', secret: false },
      { name: 'DATABASE_URL', value: 'present', secret: true },
    ];
    const resolvedConfiguration = [
      {
        caseKey: { workloadId: 'RTC-B01', caseId: 'case', inputKey: 'input' },
        field: 'innerRuns',
        value: 5,
        source: 'default',
      },
    ];
    deriveRtcBaselineWorkerProjection(
      ['run', 'worker.ts', '--capture=worker', '--rtc-inner-runs=5'],
      2,
    );
    expect({ controllerInputs, resolvedConfiguration }).toEqual({
      controllerInputs: [
        { name: 'baselineId', value: '20260807-0123456789ab-e1-local', secret: false },
        { name: 'DATABASE_URL', value: 'present', secret: true },
      ],
      resolvedConfiguration: [
        {
          caseKey: { workloadId: 'RTC-B01', caseId: 'case', inputKey: 'input' },
          field: 'innerRuns',
          value: 5,
          source: 'default',
        },
      ],
    });
  });

  it('derives the exact fixed and lexical configuration flag projection', () => {
    const argumentsList = [
      'run',
      '--config=packages/shared-rtc-bench/deno.json',
      '--allow-read',
      '--allow-write',
      'scripts/perf/example.ts',
      '--capture=worker',
      '--baseline-id=20260807-0123456789ab-e1-local',
      '--workload=RTC-B01',
      '--case-id=peer-connection-diagnostics-burst',
      '--input-key=pairs-500',
      '--intended-phase=retained',
      '--outer-ordinal=1',
      '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001',
      '--rtc-inner-runs=5',
      '--rtc-peers=500',
    ];
    expect(deriveRtcBaselineWorkerProjection(argumentsList, 5)).toEqual({
      ok: true,
      value: {
        fixedWorkerFlags: [
          '--capture=worker',
          '--baseline-id=20260807-0123456789ab-e1-local',
          '--workload=RTC-B01',
          '--case-id=peer-connection-diagnostics-burst',
          '--input-key=pairs-500',
          '--intended-phase=retained',
          '--outer-ordinal=1',
          '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001',
        ],
        configurationFlags: ['--rtc-inner-runs=5', '--rtc-peers=500'],
      },
    });
    expect(
      deriveRtcBaselineWorkerProjection(
        [
          'run',
          '--config=packages/shared-rtc-bench/deno.json',
          '--allow-read',
          '--allow-write',
          'scripts/perf/example.ts',
          '--capture=worker',
          '--baseline-id=20260807-0123456789ab-e1-local',
          '--workload=RTC-B01',
          '--case-id=peer-connection-diagnostics-burst',
          '--input-key=pairs-500',
          '--intended-phase=retained',
          '--outer-ordinal=1',
          '--sample-ids=rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001',
          '--rtc-inner-runs=5',
          '--rtc-inner-runs',
          '5',
        ],
        5,
      ),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.redactedArgv.arguments[14]',
          code: 'two-token-option',
          message: 'Worker options must use one --name=value token.',
        },
      ],
    });
  });

  it('requires repeat workload subset order and immutable conditional decision inheritance', () => {
    const primary = {
      schema: 'rallar.rtc-baseline.capture-request.v1' as const,
      baselineId: '20260807-0123456789ab-e1-local',
      workloadIds: ['RTC-B03', 'RTC-B01'] as const,
      environmentId: 'E1-local' as const,
      retainedSampleMultiplier: 1 as const,
      repeatLink: null,
      conditionalEnvironmentDecisions: [
        {
          environmentId: 'E4-pg' as const,
          decision: 'not-required' as const,
          reason: 'Neither selected synthetic workload uses persisted RTT state.',
        },
      ],
    };
    const link = {
      primaryBaselineId: '20260807-0123456789ab-e1-local',
      primarySummarySha256: 'a'.repeat(64),
    };
    expect(
      validateRtcBaselineRepeatRequest(primary, {
        ...primary,
        baselineId: '20260807-0123456789ab-e1-local-repeat-01',
        workloadIds: ['RTC-B03'],
        retainedSampleMultiplier: 2,
        repeatLink: link,
      }),
    ).toEqual([]);
    expect(
      validateRtcBaselineRepeatRequest(primary, {
        ...primary,
        baselineId: '20260807-0123456789ab-e1-local-repeat-01',
        workloadIds: ['RTC-B01', 'RTC-B03'],
        retainedSampleMultiplier: 2,
        repeatLink: link,
        conditionalEnvironmentDecisions: [
          {
            environmentId: 'E4-pg',
            decision: 'required',
            reason: 'Changed after primary.',
          },
        ],
      }),
    ).toEqual([
      {
        path: '$.workloadIds',
        code: 'repeat-workload-order',
        message: 'Repeat workloads must preserve primary subset order.',
      },
      {
        path: '$.conditionalEnvironmentDecisions',
        code: 'repeat-decision-mismatch',
        message: 'Repeat decisions must exactly inherit the primary decisions.',
      },
    ]);
  });
});
