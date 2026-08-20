import { QRtcDataChannel, type RtcDataChannelPayload } from '@shared/webrtc/QRtcDataChannel.ts';

import {
  rtcBaselineIssue,
  type RtcBaselineResult,
  type RtcBaselineSampleDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

export type RtcDataChannelDrainDepth = 32 | 1000 | 5000;
const frozenDepthByValue: Readonly<Record<string, RtcDataChannelDrainDepth>> = {
  '32': 32,
  '1000': 1000,
  '5000': 5000,
};
export interface RtcDataChannelDrainDependencies {
  readonly nativeChannel: RtcDataChannelDrainFakeNativeChannel;
  readonly clock: Readonly<{
    createdAtEpochMs: (index: number) => number;
    monotonicNow: () => number;
  }>;
  readonly payload: Readonly<{
    create: (index: number) => string;
    byteLength: (value: string) => number;
  }>;
}
export interface RtcDataChannelDrainResult {
  readonly queueDepth: number;
  readonly queuedBeforeDrain: number;
  readonly queuedAfterDrain: number;
  readonly maximumQueuedItemCount: number;
  readonly sentBeforeDrain: number;
  readonly sentDuringDrain: number;
  readonly payloadBytes: number;
  readonly sentBytesDuringDrain: number;
  readonly intervalStartedAtMs: number;
  readonly intervalCompletedAtMs: number;
  readonly drainDurationMs: number;
  readonly highWatermarkBytes: 1;
  readonly lowWatermarkBytes: 0;
  readonly overflow: 'replace-by-key';
}
interface RtcDataChannelDrainInput {
  readonly queueDepth: RtcDataChannelDrainDepth;
  readonly runs: number;
}
interface RtcDataChannelDrainAcceptedArguments {
  readonly mode: 'accepted';
  readonly input: RtcDataChannelDrainInput;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}
const acceptedNames = (
  'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
  'rtc-queue-depth rtc-payload-bytes rtc-high-watermark-bytes rtc-low-watermark-bytes ' +
  'rtc-overflow rtc-inner-runs'
).split(' ');

export function createRtcDataChannelDrainPayload(index: number): string {
  const prefix = `{"entityId":"entity-${index}","padding":"`;
  const suffix = '"}';
  return `${prefix}${'x'.repeat(256 - prefix.length - suffix.length)}${suffix}`;
}
export async function runRtcDataChannelDrain(
  queueDepth: RtcDataChannelDrainDepth,
  dependencies: RtcDataChannelDrainDependencies,
): Promise<RtcDataChannelDrainResult> {
  const peerConnection = {
    onDataChannelDo: () => peerConnection,
    createDataChannel: () => dependencies.nativeChannel,
  };
  const dataChannel = new QRtcDataChannel(peerConnection as never, {
    peerId: 'rtc-b02-peer',
    dataChannelName: 'realtime',
    flowControl: {
      highWatermarkBytes: 1,
      lowWatermarkBytes: 0,
      overflow: 'replace-by-key',
      maxQueueItems: queueDepth,
    },
  });
  const payloads = createDrainPayloads(queueDepth, dependencies.payload);
  dataChannel.connect(true);
  await dependencies.nativeChannel.emitOpen();
  dependencies.nativeChannel.bufferedAmount = 1;
  for (let index = 0; index < queueDepth; index += 1) {
    const offered = dataChannel.sendRaw(payloads[index], {
      key: `entity-${index}`,
      now: () => dependencies.clock.createdAtEpochMs(index),
    });
    if (offered.status !== 'queued') {
      throw new Error(`Expected queued fill result, received ${offered.status}.`);
    }
  }
  const beforeDrain = dataChannel.readHealth().queuedItemCount;
  const sentBeforeDrain = dependencies.nativeChannel.sent.length;
  dependencies.nativeChannel.bufferedAmount = 0;
  const startedAtMs = dependencies.clock.monotonicNow();
  await dependencies.nativeChannel.emitBufferedAmountLow();
  const completedAtMs = dependencies.clock.monotonicNow();
  const sentDuringDrain = dependencies.nativeChannel.sent.length - sentBeforeDrain;
  return {
    queueDepth,
    queuedBeforeDrain: beforeDrain,
    queuedAfterDrain: dataChannel.readHealth().queuedItemCount,
    maximumQueuedItemCount: beforeDrain,
    sentBeforeDrain,
    sentDuringDrain,
    payloadBytes: 256,
    sentBytesDuringDrain: sentDuringDrain * 256,
    intervalStartedAtMs: startedAtMs,
    intervalCompletedAtMs: completedAtMs,
    drainDurationMs: completedAtMs - startedAtMs,
    highWatermarkBytes: 1,
    lowWatermarkBytes: 0,
    overflow: 'replace-by-key',
  };
}
export function parseRtcDataChannelDrainArguments(arguments_: readonly string[]) {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedNames : ['queue-depth', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}
export async function runRtcDataChannelDrainAcceptedSamples(input: {
  readonly worker: RtcDataChannelDrainAcceptedArguments;
  readonly run: () => Promise<RtcDataChannelDrainResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: {
      ...input.worker,
      workloadId: 'RTC-B02',
      caseId: 'data-channel-drain',
      inputKey: `depth-${input.worker.input.queueDepth}`,
    },
    run: input.run,
    validate: (result) => validateResult(input.worker.input.queueDepth, result),
    createSample: ({ identity, result, issues }) => ({
      schema: 'rallar.rtc-baseline.sample.v1',
      identity,
      outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
      evidenceClass: 'synthetic-path',
      metrics:
        result === null
          ? []
          : [{ metric: 'drainDurationMs', unit: 'ms', value: result.drainDurationMs }],
      rawEvidence: result === null ? null : { ...result },
      rawReferences: [],
      issues,
      runtimeObservation: null,
    }),
  });
}
function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
  const depth = parseFrozenDepth(options['queue-depth'] ?? '5000', 'queue-depth');
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  const out = options.out ?? 'tmp/perf/results/rtc-data-channel-drain.json';
  const issues = [...(!depth.ok ? depth.issues : []), ...(!runs.ok ? runs.issues : [])];
  const confinedOutput =
    out.startsWith('tmp/perf/results/') &&
    !out.includes('\\') &&
    out
      .split('/')
      .every((component) => component !== '' && component !== '.' && component !== '..');
  if (!confinedOutput) {
    issues.push(
      rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.'),
    );
  }
  const queueDepth = depth.ok ? depth.value : 32;
  const runCount = runs.ok ? runs.value : 1;
  return issues.length > 0
    ? { ok: false as const, issues }
    : {
        ok: true as const,
        value: { mode: 'diagnostic' as const, input: { queueDepth, runs: runCount }, out },
      };
}
function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
  const depth = parseFrozenDepth(options['rtc-queue-depth'] ?? '', 'rtc-queue-depth');
  const outer = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const issues = [...(!depth.ok ? depth.issues : []), ...(!outer.ok ? outer.issues : [])];
  issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
  const expected = depth.ok
    ? {
        capture: 'worker',
        workload: 'RTC-B02',
        'case-id': 'data-channel-drain',
        'input-key': `depth-${depth.value}`,
        'rtc-payload-bytes': '256',
        'rtc-high-watermark-bytes': '1',
        'rtc-low-watermark-bytes': '0',
        'rtc-overflow': 'replace-by-key',
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
  const sampleIds = (options['sample-ids'] ?? '').split(',');
  const queueDepth = depth.ok ? depth.value : 32;
  const expectedIds = createExpectedSampleIds(
    queueDepth,
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
          input: { queueDepth, runs: 5 },
          intendedPhase: phase as 'warmup' | 'retained',
          outerOrdinal: ordinal,
          sampleIds,
        },
      };
}
function parseFrozenDepth(
  value: string,
  name: string,
): RtcBaselineResult<RtcDataChannelDrainDepth> {
  const depth = frozenDepthByValue[value];
  if (depth !== undefined) return { ok: true as const, value: depth };
  return {
    ok: false as const,
    issues: [
      rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', 'Expected 32, 1000, or 5000.'),
    ],
  };
}
function createExpectedSampleIds(
  depth: number,
  phase: 'warmup' | 'retained',
  outerOrdinal: number,
): string[] {
  const prefix =
    `rtc-b02-data-channel-drain-depth-${depth}-${phase}-` + String(outerOrdinal).padStart(3, '0');
  return Array.from(
    { length: 5 },
    (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
}
function createDrainPayloads(
  queueDepth: RtcDataChannelDrainDepth,
  payloadDependency: RtcDataChannelDrainDependencies['payload'],
): string[] {
  return Array.from({ length: queueDepth }, (_value, index) => {
    const payload = payloadDependency.create(index);
    if (payloadDependency.byteLength(payload) !== 256) {
      throw new Error(`Payload ${index} must contain exactly 256 UTF-8 bytes.`);
    }
    return payload;
  });
}
function validateResult(depth: RtcDataChannelDrainDepth, result: RtcDataChannelDrainResult) {
  const issues = [];
  if (
    result.queueDepth !== depth ||
    result.queuedBeforeDrain !== depth ||
    result.queuedAfterDrain !== 0 ||
    result.maximumQueuedItemCount !== depth
  ) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.queueDepth', 'queue-bound-mismatch', 'Unexpected.'),
    );
  }
  if (result.sentBeforeDrain !== 0 || result.sentDuringDrain !== depth) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.sentDuringDrain', 'send-count-mismatch', 'Unexpected.'),
    );
  }
  if (result.payloadBytes !== 256 || result.sentBytesDuringDrain !== depth * 256) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.sentBytesDuringDrain', 'byte-count-mismatch', 'Unexpected.'),
    );
  }
  if (
    result.drainDurationMs !== result.intervalCompletedAtMs - result.intervalStartedAtMs ||
    result.drainDurationMs < 0
  ) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.drainDurationMs', 'interval-mismatch', 'Unexpected.'),
    );
  }
  if (
    result.highWatermarkBytes !== 1 ||
    result.lowWatermarkBytes !== 0 ||
    result.overflow !== 'replace-by-key'
  ) {
    issues.push(
      rtcBaselineIssue('$.rawEvidence.flowControl', 'flow-control-mismatch', 'Unexpected.'),
    );
  }
  return issues;
}

function createDefaultDependencies(): RtcDataChannelDrainDependencies {
  const encoder = new TextEncoder();
  return {
    nativeChannel: new RtcDataChannelDrainFakeNativeChannel(),
    clock: {
      createdAtEpochMs: (index) => 1_700_000_000_000 + index,
      monotonicNow: () => performance.now(),
    },
    payload: {
      create: createRtcDataChannelDrainPayload,
      byteLength: (value) => encoder.encode(value).byteLength,
    },
  };
}
async function main(): Promise<void> {
  const parsed = parseRtcDataChannelDrainArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const writeLine = console.log.bind(console);
  console.log = () => {};
  console.warn = () => {};
  if (parsed.value.mode === 'accepted') {
    const samples = await runRtcDataChannelDrainAcceptedSamples({
      worker: parsed.value,
      run: () => runRtcDataChannelDrain(parsed.value.input.queueDepth, createDefaultDependencies()),
    });
    writeLine(JSON.stringify(samples));
    return;
  }
  const results = [];
  for (let run = 1; run <= parsed.value.input.runs; run += 1) {
    results.push({
      run,
      ...(await runRtcDataChannelDrain(parsed.value.input.queueDepth, createDefaultDependencies())),
    });
  }
  const output = { input: parsed.value.input, results };
  await Deno.writeTextFile(parsed.value.out, `${JSON.stringify(output, null, 2)}\n`, {
    createNew: true,
  });
  writeLine(`Wrote ${parsed.value.out}`);
}

export class RtcDataChannelDrainFakeNativeChannel {
  readonly sent: RtcDataChannelPayload[] = [];
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 1;
  onopen: (() => void | Promise<void>) | null = null;
  onbufferedamountlow: (() => void | Promise<void>) | null = null;
  private readonly onSend: (data: RtcDataChannelPayload) => void;
  constructor(onSend: (data: RtcDataChannelPayload) => void = () => {}) {
    this.onSend = onSend;
  }
  send(data: RtcDataChannelPayload): void {
    this.sent.push(data);
    this.onSend(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  async emitOpen(): Promise<void> {
    this.readyState = 'open';
    await this.onopen?.();
  }
  async emitBufferedAmountLow(): Promise<void> {
    await this.onbufferedamountlow?.();
  }
}
if (import.meta.main) await main();
