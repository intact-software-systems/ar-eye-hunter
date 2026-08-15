import { dirname } from 'node:path';

import { WebRtcHeartbeatService } from '@shared/services/WebRtcHeartbeatService.ts';

import {
  rtcBaselineIssue,
  type RtcBaselineIssueDto,
  type RtcBaselineJson,
  type RtcBaselineResult,
  type RtcBaselineSampleDto,
  type RtcBaselineSampleIdentityDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import {
  runRtcBaselineAcceptedWorkerSamples,
} from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

interface CallbackDto {
  readonly onMessage: (data: unknown) => Promise<void>;
}

export interface WebRtcHeartbeatCallbackChurnInput {
  readonly channels: number;
}

interface WebRtcHeartbeatCallbackChurnDiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly input: WebRtcHeartbeatCallbackChurnInput;
  readonly runs: number;
  readonly out: string;
}

export interface WebRtcHeartbeatCallbackChurnAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: WebRtcHeartbeatCallbackChurnInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface WebRtcHeartbeatCallbackChurnResult {
  readonly durationMs: number;
  readonly channelCount: number;
  readonly retainedCallbacks: number;
  readonly maxCallbacksPerChannel: number;
}

interface ValidateAcceptedArgumentsInput {
  readonly options: Readonly<Record<string, string>>;
  readonly channels: number;
  readonly outerOrdinal: RtcBaselineResult<number>;
  readonly intendedPhase: string | undefined;
  readonly sampleIds: readonly string[];
}

const acceptedOptionNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-inner-runs rtc-channels'
).split(' ');
const acceptedChannels = 10000;

class FakeHeartbeatChannel {
  private readonly callbacks = new Map<string, CallbackDto>();

  onRtcMessageDo(id: string, callback: CallbackDto, _type: string): this {
    this.callbacks.set(id, callback);
    return this;
  }

  removeOnRtcMessageCallbackById(id: string): boolean {
    return this.callbacks.delete(id);
  }

  sendAsJsonString(_data: string): Promise<void> {
    return Promise.resolve();
  }

  isOpen(): boolean {
    return true;
  }

  callbackCount(): number {
    return this.callbacks.size;
  }
}

export function parseWebRtcHeartbeatCallbackChurnArguments(
  arguments_: readonly string[],
): RtcBaselineResult<
  WebRtcHeartbeatCallbackChurnDiagnosticArguments | WebRtcHeartbeatCallbackChurnAcceptedArguments
> {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedOptionNames : ['channels', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export function runWebRtcHeartbeatCallbackChurn(
  input: WebRtcHeartbeatCallbackChurnInput,
): WebRtcHeartbeatCallbackChurnResult {
  const channels = Array.from({ length: input.channels }, () => new FakeHeartbeatChannel());
  const startedAt = performance.now();

  for (let index = 0; index < channels.length; index += 1) {
    const service = new WebRtcHeartbeatService({
      sessionId: `self-${index}`,
      peerSessionId: `peer-${index}`,
      channel: channels[index] as never,
      maxMissedPings: 3,
      pingFrequencyMsecs: 60_000,
    });
    service.start({
      onHeartbeat: async () => {},
      onMissedHeartbeat: async () => {},
    });
    service.stop();
  }

  return {
    durationMs: performance.now() - startedAt,
    channelCount: input.channels,
    retainedCallbacks: channels.reduce((sum, channel) => sum + channel.callbackCount(), 0),
    maxCallbacksPerChannel: Math.max(...channels.map((channel) => channel.callbackCount())),
  };
}

export function runWebRtcHeartbeatCallbackChurnAcceptedSamples(input: {
  readonly worker: WebRtcHeartbeatCallbackChurnAcceptedArguments;
  readonly run: () =>
    | WebRtcHeartbeatCallbackChurnResult
    | Promise<WebRtcHeartbeatCallbackChurnResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B04',
      caseId: 'heartbeat-callback-churn',
      inputKey: 'fixed',
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) => createSample(identity, result, issues),
  });
}

function parseDiagnosticArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcHeartbeatCallbackChurnDiagnosticArguments> {
  const channels = parseRtcBaselineBoundedInteger(
    options.channels ?? '10000',
    'channels',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const issues = [...(!channels.ok ? channels.issues : []), ...(!runs.ok ? runs.issues : [])];
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'diagnostic',
      input: { channels: channels.ok ? channels.value : 1 },
      runs: runs.ok ? runs.value : 1,
      out: options.out ?? 'tmp/perf/results/webrtc-heartbeat-callback-churn.json',
    },
  };
}

function parseAcceptedArguments(
  options: Readonly<Record<string, string>>,
): RtcBaselineResult<WebRtcHeartbeatCallbackChurnAcceptedArguments> {
  const channels = parseRtcBaselineBoundedInteger(
    options['rtc-channels'] ?? '',
    'rtc-channels',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const outerOrdinal = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const intendedPhase = options['intended-phase'];
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const parsedChannels = channels.ok ? channels.value : acceptedChannels;
  const issues = [
    ...(!channels.ok ? channels.issues : []),
    ...(!outerOrdinal.ok ? outerOrdinal.issues : []),
    ...validateRtcBaselineId(options['baseline-id'] ?? ''),
    ...validateAcceptedArguments({
      options,
      channels: parsedChannels,
      outerOrdinal,
      intendedPhase,
      sampleIds,
    }),
  ];
  return issues.length > 0 ? { ok: false, issues } : {
    ok: true,
    value: {
      mode: 'accepted',
      input: { channels: parsedChannels },
      intendedPhase: intendedPhase as 'warmup' | 'retained',
      outerOrdinal: outerOrdinal.ok ? outerOrdinal.value : 1,
      sampleIds,
    },
  };
}

function validateAcceptedArguments(input: ValidateAcceptedArgumentsInput): RtcBaselineIssueDto[] {
  const expected = {
    capture: 'worker',
    workload: 'RTC-B04',
    'case-id': 'heartbeat-callback-churn',
    'input-key': 'fixed',
    'rtc-inner-runs': '5',
    'rtc-channels': String(acceptedChannels),
  };
  const issues = Object.entries(expected).flatMap(([name, value]) =>
    input.options[name] === value
      ? []
      : [rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`)]
  );
  if (input.channels !== acceptedChannels) {
    issues.push(rtcBaselineIssue('$.input', 'unexpected-worker-input', 'Expected fixed input.'));
  }
  if (
    !input.outerOrdinal.ok ||
    input.options['outer-ordinal'] !== String(input.outerOrdinal.value)
  ) {
    issues.push(
      rtcBaselineIssue(
        '$.outer-ordinal',
        'unexpected-worker-input',
        'Expected canonical integer syntax.',
      ),
    );
  }
  if (input.intendedPhase !== 'warmup' && input.intendedPhase !== 'retained') {
    issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
  }
  const phase = input.intendedPhase === 'warmup' ? 'warmup' : 'retained';
  const ordinal = input.outerOrdinal.ok ? input.outerOrdinal.value : 1;
  if (JSON.stringify(input.sampleIds) !== JSON.stringify(createExpectedSampleIds(phase, ordinal))) {
    issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
  }
  return issues;
}

function createExpectedSampleIds(
  intendedPhase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix = `rtc-b04-heartbeat-callback-churn-fixed-${intendedPhase}-${
    String(outerOrdinal).padStart(3, '0')
  }`;
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function validateResult(
  input: WebRtcHeartbeatCallbackChurnInput,
  result: WebRtcHeartbeatCallbackChurnResult,
): RtcBaselineIssueDto[] {
  const issues: RtcBaselineIssueDto[] = [];
  if (result.channelCount !== input.channels || !Number.isSafeInteger(result.channelCount)) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.channelCount', 'input-mismatch', 'Unexpected input.'),
    );
  }
  if (
    !Number.isSafeInteger(result.retainedCallbacks) ||
    !Number.isSafeInteger(result.maxCallbacksPerChannel) ||
    result.retainedCallbacks !== 0 ||
    result.maxCallbacksPerChannel !== 0
  ) {
    issues.push(
      rtcBaselineIssue(
        '$.rawEvidence.callbacks',
        'callback-retention',
        'Heartbeat callbacks must be removed.',
      ),
    );
  }
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.durationMs', 'invalid-timing', 'Expected nonnegative.'),
    );
  }
  return issues;
}

function createSample(
  identity: RtcBaselineSampleIdentityDto,
  result: WebRtcHeartbeatCallbackChurnResult | null,
  issues: readonly RtcBaselineIssueDto[],
): RtcBaselineSampleDto {
  if (result === null) {
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
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: issues.length === 0 ? 'passed' : 'failed',
    evidenceClass: 'synthetic-path',
    metrics: Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }]
      : [],
    rawEvidence: toRawEvidence(result),
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function toRawEvidence(result: WebRtcHeartbeatCallbackChurnResult): RtcBaselineJson {
  return {
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    channelCount: result.channelCount,
    retainedCallbacks: result.retainedCallbacks,
    maxCallbacksPerChannel: result.maxCallbacksPerChannel,
  };
}

async function main(): Promise<void> {
  const parsed = parseWebRtcHeartbeatCallbackChurnArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  if (parsed.value.mode === 'accepted') {
    const worker = parsed.value;
    console.log(
      JSON.stringify(
        await runWebRtcHeartbeatCallbackChurnAcceptedSamples({
          worker,
          run: () => runWebRtcHeartbeatCallbackChurn(worker.input),
        }),
      ),
    );
    return;
  }
  const diagnostic = parsed.value;
  const results = [];
  for (let run = 1; run <= diagnostic.runs; run += 1) {
    results.push({ run, ...runWebRtcHeartbeatCallbackChurn(diagnostic.input) });
  }
  const output = {
    createdAt: new Date().toISOString(),
    input: { channelCount: diagnostic.input.channels, runs: diagnostic.runs },
    results,
  };
  await Deno.mkdir(dirname(diagnostic.out), { recursive: true });
  await Deno.writeTextFile(diagnostic.out, JSON.stringify(output, null, 2));
  console.log(`Wrote ${diagnostic.out}`);
}

if (import.meta.main) await main();
