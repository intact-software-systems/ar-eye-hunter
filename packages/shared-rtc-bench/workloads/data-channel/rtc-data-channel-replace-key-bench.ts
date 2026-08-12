import { QRtcDataChannel, type RtcDataChannelPayload } from '@shared/webrtc/QRtcDataChannel.ts';

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

interface RtcDataChannelReplaceKeyInput {
  readonly queueDepth: number;
  readonly replacements: number;
  readonly runs: number;
}

interface RtcDataChannelReplaceKeyAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: RtcDataChannelReplaceKeyInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}

export interface RtcDataChannelReplaceKeyResult {
  readonly fillDurationMs: number;
  readonly replacementDurationMs: number;
  readonly totalDurationMs: number;
  readonly queueDepth: number;
  readonly replacements: number;
  readonly queuedItemCount: number;
  readonly sentCount: number;
  readonly counters: Readonly<Record<string, number>>;
}

const frozenDepths = new Set<number>([32, 1000, 5000]);
const acceptedNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-queue-depth rtc-replacements rtc-inner-runs'
).split(' ');

export function parseRtcDataChannelReplaceKeyArguments(arguments_: readonly string[]) {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedNames : ['queue-size', 'replacements', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcDataChannelReplaceKey(
  queueDepth: number,
  replacements: number,
): Promise<RtcDataChannelReplaceKeyResult> {
  const nativeChannel = new FakeRtcDataChannel('realtime');
  const peerConnection = {
    onDataChannelDo: () => peerConnection,
    createDataChannel: () => nativeChannel,
  };
  const dataChannel = new QRtcDataChannel(peerConnection as never, {
    peerId: 'peer-1',
    dataChannelName: 'realtime',
    flowControl: {
      highWatermarkBytes: 1,
      lowWatermarkBytes: 0,
      overflow: 'replace-by-key',
      maxQueueItems: queueDepth,
    },
  });
  dataChannel.connect(true);
  await nativeChannel.emitOpen();
  nativeChannel.bufferedAmount = 1;

  const totalStart = performance.now();
  const fillStart = performance.now();
  for (let index = 0; index < queueDepth; index += 1) {
    const result = dataChannel.sendJson(createPayload(index), {
      key: `entity-${index}`,
      now: () => 1_700_000_000_000,
    });
    if (result.status !== 'queued') {
      throw new Error(`Expected queued during fill, received ${result.status}.`);
    }
  }
  const fillDurationMs = performance.now() - fillStart;
  const replacementStart = performance.now();
  for (let index = 0; index < replacements; index += 1) {
    const result = dataChannel.sendJson(createPayload(index + queueDepth), {
      key: `entity-${index % queueDepth}`,
      now: () => 1_700_000_000_001 + index,
    });
    if (result.status !== 'replaced') {
      throw new Error(`Expected replaced during replacements, received ${result.status}.`);
    }
  }
  const replacementDurationMs = performance.now() - replacementStart;
  const health = dataChannel.readHealth();
  return {
    fillDurationMs,
    replacementDurationMs,
    totalDurationMs: performance.now() - totalStart,
    queueDepth,
    replacements,
    queuedItemCount: health.queuedItemCount,
    sentCount: nativeChannel.sent.length,
    counters: health.counters,
  };
}

export async function runRtcDataChannelReplaceKeyAcceptedSamples(input: {
  readonly worker: RtcDataChannelReplaceKeyAcceptedArguments;
  readonly run: () => Promise<RtcDataChannelReplaceKeyResult>;
}): Promise<RtcBaselineSampleDto[]> {
  const samples: RtcBaselineSampleDto[] = [];
  let failureId: string | undefined;
  for (let index = 0; index < input.worker.sampleIds.length; index += 1) {
    const identity = createIdentity(input.worker, index);
    if (failureId !== undefined) {
      samples.push(
        createSample(identity, null, [
          rtcBaselineIssue('$.rawEvidence', 'causal-not-run', failureId),
        ]),
      );
      continue;
    }
    const result = await input.run();
    const issues = validateResult(input.worker.input, result);
    if (issues.length > 0) failureId = identity.sampleId;
    samples.push(createSample(identity, result, issues));
  }
  return samples;
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
  const queueDepth = parseRtcBaselineBoundedInteger(
    options['queue-size'] ?? '5000',
    'queue-size',
    1,
    5000,
  );
  const replacements = parseRtcBaselineBoundedInteger(
    options.replacements ?? '25000',
    'replacements',
    1,
    25000,
  );
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const out = options.out ?? 'tmp/perf/results/rtc-data-channel-replace-key.json';
  const issues = [
    ...(!queueDepth.ok ? queueDepth.issues : []),
    ...(!replacements.ok ? replacements.issues : []),
    ...(!runs.ok ? runs.issues : []),
  ];
  if (!isDiagnosticOutput(out)) {
    issues.push(
      rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.'),
    );
  }
  const queueDepthValue = queueDepth.ok ? queueDepth.value : 1;
  const replacementCount = replacements.ok ? replacements.value : 1;
  const runCount = runs.ok ? runs.value : 1;
  return issues.length > 0
    ? { ok: false as const, issues }
    : {
        ok: true as const,
        value: {
          mode: 'diagnostic' as const,
          input: { queueDepth: queueDepthValue, replacements: replacementCount, runs: runCount },
          out,
        },
      };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
  const queueDepth = parseRtcBaselineBoundedInteger(
    options['rtc-queue-depth'] ?? '',
    'rtc-queue-depth',
    32,
    5000,
  );
  const outer = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const issues = [...(!queueDepth.ok ? queueDepth.issues : []), ...(!outer.ok ? outer.issues : [])];
  if (queueDepth.ok && !frozenDepths.has(queueDepth.value)) {
    issues.push(
      rtcBaselineIssue(
        '$.rtc-queue-depth',
        'unexpected-worker-input',
        'Expected 32, 1000, or 5000.',
      ),
    );
  }
  issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
  const expected = queueDepth.ok
    ? {
        capture: 'worker',
        workload: 'RTC-B02',
        'case-id': 'data-channel-replace-key',
        'input-key': `depth-${queueDepth.value}`,
        'rtc-queue-depth': String(queueDepth.value),
        'rtc-replacements': '25000',
        'rtc-inner-runs': '5',
      }
    : {};
  for (const [name, value] of Object.entries(expected)) {
    if (options[name] !== value) {
      issues.push(rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`));
    }
  }
  const phase = options['intended-phase'];
  if (phase !== 'warmup' && phase !== 'retained') {
    issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
  }
  const ordinal = outer.ok ? outer.value : 0;
  const depth = queueDepth.ok ? queueDepth.value : 32;
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const expectedIds = createExpectedSampleIds(
    depth,
    phase === 'warmup' ? phase : 'retained',
    ordinal,
  );
  if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
    issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
  }
  return issues.length > 0
    ? { ok: false as const, issues }
    : {
        ok: true as const,
        value: {
          mode: 'accepted' as const,
          input: { queueDepth: depth, replacements: 25000, runs: 5 },
          intendedPhase: phase as 'warmup' | 'retained',
          outerOrdinal: ordinal,
          sampleIds,
        },
      };
}

function createExpectedSampleIds(
  depth: number,
  phase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix =
    `rtc-b02-data-channel-replace-key-depth-${depth}-${phase}-` +
    String(outerOrdinal).padStart(3, '0');
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function createIdentity(
  worker: RtcDataChannelReplaceKeyAcceptedArguments,
  index: number,
): RtcBaselineSampleIdentityDto {
  return {
    sampleId: worker.sampleIds[index],
    workloadId: 'RTC-B02',
    caseId: 'data-channel-replace-key',
    inputKey: `depth-${worker.input.queueDepth}`,
    intendedPhase: worker.intendedPhase,
    outerOrdinal: worker.outerOrdinal,
    innerOrdinal: index + 1,
  };
}

function createSample(
  identity: RtcBaselineSampleIdentityDto,
  result: RtcDataChannelReplaceKeyResult | null,
  issues: RtcBaselineSampleDto['issues'],
): RtcBaselineSampleDto {
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
    evidenceClass: 'synthetic-path',
    metrics:
      result === null
        ? []
        : [{ metric: 'replacementDurationMs', unit: 'ms', value: result.replacementDurationMs }],
    rawEvidence: result === null ? null : { ...result, counters: { ...result.counters } },
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function validateResult(
  input: RtcDataChannelReplaceKeyInput,
  result: RtcDataChannelReplaceKeyResult,
) {
  const issues = [];
  if (result.queueDepth !== input.queueDepth || result.queuedItemCount !== input.queueDepth) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.queueDepth', 'queue-bound-mismatch', 'Unexpected.'),
    );
  }
  if (
    result.replacements !== input.replacements ||
    result.counters.replaced !== input.replacements
  ) {
    issues.push(rtcBaselineIssue('$.rawEvidence.replacements', 'counter-mismatch', 'Unexpected.'));
  }
  if (result.counters.queued !== input.queueDepth || result.sentCount !== 0) {
    issues.push(rtcBaselineIssue('$.rawEvidence.sentCount', 'send-count-mismatch', 'Unexpected.'));
  }
  return issues;
}

function createPayload(sequence: number): Record<string, number> {
  return { sequence, x: sequence % 1024, y: sequence % 2048 };
}

function isDiagnosticOutput(out: string): boolean {
  return (
    out.startsWith('tmp/perf/results/') &&
    !out.includes('\\') &&
    out.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
  );
}

async function main(): Promise<void> {
  const parsed = parseRtcDataChannelReplaceKeyArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const writeLine = console.log.bind(console);
  console.log = () => {};
  console.warn = () => {};
  if (parsed.value.mode === 'accepted') {
    const samples = await runRtcDataChannelReplaceKeyAcceptedSamples({
      worker: parsed.value,
      run: () =>
        runRtcDataChannelReplaceKey(parsed.value.input.queueDepth, parsed.value.input.replacements),
    });
    writeLine(JSON.stringify(samples));
    return;
  }
  const results = [];
  for (let run = 1; run <= parsed.value.input.runs; run += 1) {
    results.push({
      run,
      ...(await runRtcDataChannelReplaceKey(
        parsed.value.input.queueDepth,
        parsed.value.input.replacements,
      )),
    });
  }
  await Deno.writeTextFile(
    parsed.value.out,
    `${JSON.stringify(
      {
        input: parsed.value.input,
        results,
      },
      null,
      2,
    )}\n`,
    { createNew: true },
  );
  writeLine(`Wrote ${parsed.value.out}`);
}

class FakeRtcDataChannel {
  readonly label: string;
  readonly sent: RtcDataChannelPayload[] = [];
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 1;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  onmessage: ((event: MessageEvent) => void | Promise<void>) | null = null;
  onopen: (() => void | Promise<void>) | null = null;
  onclose: (() => void | Promise<void>) | null = null;
  onerror: (() => void | Promise<void>) | null = null;
  onbufferedamountlow: (() => void | Promise<void>) | null = null;

  constructor(label: string) {
    this.label = label;
  }
  send(data: RtcDataChannelPayload): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  async emitOpen(): Promise<void> {
    this.readyState = 'open';
    await this.onopen?.();
  }
}

if (import.meta.main) await main();
