import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';

import {
  rtcBaselineIssue,
  type RtcBaselineJson,
  type RtcBaselineSampleIdentityDto,
  type RtcBaselineSampleDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  parseRtcBaselineBoundedInteger,
  parseRtcBaselineOneTokenOptions,
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import {
  runRtcBaselineAcceptedWorkerSamples,
} from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';

type Listener = (event?: Event) => void;
interface ListenerInput {
  readonly peers: number;
  readonly runs: number;
}
interface DiagnosticArguments {
  readonly mode: 'diagnostic';
  readonly input: ListenerInput;
  readonly out: string;
}
interface AcceptedArguments {
  readonly mode: 'accepted';
  readonly input: ListenerInput;
  readonly baselineId: string;
  readonly intendedPhase: 'warmup' | 'retained';
  readonly outerOrdinal: number;
  readonly sampleIds: readonly string[];
}
export interface RtcPeerListenerCleanupResult {
  readonly durationMs: number;
  readonly peerCount: number;
  readonly retainedIceGatheringListeners: number;
  readonly maxListenersPerPeer: number;
  readonly unclearedHandlerSlots: number;
}
interface BenchResult extends RtcPeerListenerCleanupResult {
  readonly run: number;
}
interface CreateRtcPeerListenerCleanupSampleInput {
  readonly identity: RtcBaselineSampleIdentityDto;
  readonly outcome: 'passed' | 'failed' | 'not-run';
  readonly rawEvidence: RtcPeerListenerCleanupResult | null;
  readonly issues: RtcBaselineSampleDto['issues'];
}

const acceptedNames = [
  'capture',
  'baseline-id',
  'workload',
  'case-id',
  'input-key',
  'intended-phase',
  'outer-ordinal',
  'sample-ids',
  'rtc-inner-runs',
  'rtc-peers',
];

export function parseRtcPeerListenerCleanupArguments(arguments_: readonly string[]) {
  const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
  const parsed = parseRtcBaselineOneTokenOptions(
    arguments_,
    accepted ? acceptedNames : ['peers', 'runs', 'out'],
  );
  if (!parsed.ok) return parsed;
  return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcPeerListenerCleanupAcceptedSamples(input: {
  worker: AcceptedArguments;
  run: () => Promise<RtcPeerListenerCleanupResult>;
}): Promise<RtcBaselineSampleDto[]> {
  return runRtcBaselineAcceptedWorkerSamples({
    worker: acceptedWorkerIdentity(input.worker),
    run: input.run,
    validate: (result) => validateResult(input.worker.input, result),
    createSample: ({ identity, result, issues }) =>
      createSample({
        identity,
        outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
        rawEvidence: result,
        issues,
      }),
  });
}

function acceptedWorkerIdentity(worker: AcceptedArguments) {
  return {
    ...worker,
    workloadId: 'RTC-B01' as const,
    caseId: 'peer-listener-cleanup',
    inputKey: 'peers-10000',
  };
}

async function main(): Promise<void> {
  const parsed = parseRtcPeerListenerCleanupArguments(Deno.args);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const writeLine = console.log.bind(console);
  console.log = () => {};
  const originalPeerConnection = globalThis.RTCPeerConnection;
  Reflect.set(globalThis, 'RTCPeerConnection', FakeRTCPeerConnection);
  try {
    if (parsed.value.mode === 'accepted') {
      const samples = await runRtcPeerListenerCleanupAcceptedSamples({
        worker: parsed.value,
        run: async () => runListenerCleanup(parsed.value.input.peers),
      });
      writeLine(JSON.stringify(samples));
      return;
    }
    const results: BenchResult[] = [];
    for (let run = 1; run <= parsed.value.input.runs; run += 1) {
      results.push({ run, ...runListenerCleanup(parsed.value.input.peers) });
    }
    await Deno.writeTextFile(
      parsed.value.out,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          input: { peerCount: parsed.value.input.peers, runs: parsed.value.input.runs },
          results,
        },
        null,
        2,
      ),
      { createNew: true },
    );
    writeLine(`Wrote ${parsed.value.out}`);
  } finally {
    Reflect.set(globalThis, 'RTCPeerConnection', originalPeerConnection);
  }
}

function runListenerCleanup(peers: number): RtcPeerListenerCleanupResult {
  FakeRTCPeerConnection.instances = [];
  const startedAt = performance.now();
  for (let index = 0; index < peers; index += 1) {
    const peer = new QRtcPeerConnection(
      { send: async () => {} },
      {
        sessionId: `self-${index}`,
        token: 'token',
        peerSessionId: `peer-${index}`,
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: true,
      },
    );
    peer.connect();
    peer.reset();
  }
  const durationMs = performance.now() - startedAt;
  const listenerCounts = FakeRTCPeerConnection.instances.map((peer) =>
    peer.listenerCount('icegatheringstatechange'),
  );
  return {
    durationMs,
    peerCount: peers,
    retainedIceGatheringListeners: listenerCounts.reduce((sum, count) => sum + count, 0),
    maxListenersPerPeer: Math.max(...listenerCounts),
    unclearedHandlerSlots: FakeRTCPeerConnection.instances.reduce(
      (sum, peer) => sum + peer.unclearedHandlerSlotCount(),
      0,
    ),
  };
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
  const out = options.out ?? 'tmp/perf/results/rtc-peer-listener-cleanup.json';
  const outComponents = out.split('/');
  const validOut =
    out.startsWith('tmp/perf/results/') &&
    !out.includes('\\') &&
    outComponents.every((component) => component !== '' && component !== '.' && component !== '..');
  const peers = parseRtcBaselineBoundedInteger(options.peers ?? '10000', 'peers', 1, 10000);
  const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
  if (!peers.ok || !runs.ok || !validOut) {
    return {
      ok: false as const,
      issues: [
        ...(!peers.ok ? peers.issues : []),
        ...(!runs.ok ? runs.issues : []),
        ...(!validOut
          ? [rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')]
          : []),
      ],
    };
  }
  return {
    ok: true as const,
    value: {
      mode: 'diagnostic' as const,
      input: { peers: peers.value, runs: runs.value },
      out,
    },
  };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
  const outer = parseRtcBaselineBoundedInteger(
    options['outer-ordinal'] ?? '',
    'outer-ordinal',
    1,
    999,
  );
  const issues = outer.ok ? [] : [...outer.issues];
  issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
  const expected = {
    capture: 'worker',
    workload: 'RTC-B01',
    'case-id': 'peer-listener-cleanup',
    'input-key': 'peers-10000',
    'rtc-inner-runs': '5',
    'rtc-peers': '10000',
  };
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
  const expectedIds = createExpectedSampleIds(phase === 'warmup' ? phase : 'retained', ordinal);
  if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
    issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
  }
  return issues.length > 0
    ? { ok: false as const, issues }
    : {
        ok: true as const,
        value: {
          mode: 'accepted' as const,
          input: { peers: 10000, runs: 5 },
          baselineId: options['baseline-id']!,
          intendedPhase: phase as 'warmup' | 'retained',
          outerOrdinal: ordinal,
          sampleIds,
        },
      };
}

function createExpectedSampleIds(phase: string, outerOrdinal: number): string[] {
  const attemptPrefix =
    `rtc-b01-peer-listener-cleanup-peers-10000-${phase}-` + String(outerOrdinal).padStart(3, '0');
  return Array.from(
    { length: 5 },
    (_value, index) => `${attemptPrefix}-${String(index + 1).padStart(3, '0')}`,
  );
}

function createSample(sampleInput: CreateRtcPeerListenerCleanupSampleInput): RtcBaselineSampleDto {
  const { identity, outcome, rawEvidence, issues } = sampleInput;
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome,
    evidenceClass: 'synthetic-path',
    metrics: rawEvidence
      ? [{ metric: 'durationMs', unit: 'ms', value: rawEvidence.durationMs }]
      : [],
    rawEvidence: rawEvidence === null ? null : createRawEvidence(rawEvidence),
    rawReferences: [],
    issues,
    runtimeObservation: null,
  };
}

function validateResult(input: ListenerInput, result: RtcPeerListenerCleanupResult) {
  const issues = [];
  if (result.peerCount !== input.peers) {
    issues.push(rtcBaselineIssue('$.rawEvidence.peerCount', 'counter-mismatch', 'Unexpected.'));
  }
  for (const name of [
    'retainedIceGatheringListeners',
    'maxListenersPerPeer',
    'unclearedHandlerSlots',
  ] as const) {
    if (result[name] !== 0) {
      issues.push(rtcBaselineIssue(`$.rawEvidence.${name}`, 'cleanup-nonzero', 'Expected 0.'));
    }
  }
  return issues;
}

function createRawEvidence(result: RtcPeerListenerCleanupResult): RtcBaselineJson {
  return {
    durationMs: result.durationMs,
    peerCount: result.peerCount,
    retainedIceGatheringListeners: result.retainedIceGatheringListeners,
    maxListenersPerPeer: result.maxListenersPerPeer,
    unclearedHandlerSlots: result.unclearedHandlerSlots,
  };
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => Promise<void>) | null =
    null;
  ondatachannel: ((event: RTCDataChannelEvent) => Promise<void>) | null = null;
  ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(_configuration: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    const listeners = (this.listeners.get(type) ?? []).filter((value) => value !== listener);
    if (listeners.length === 0) this.listeners.delete(type);
    else this.listeners.set(type, listeners);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  unclearedHandlerSlotCount(): number {
    return [
      this.onnegotiationneeded,
      this.onicecandidate,
      this.ondatachannel,
      this.ontrack,
      this.oniceconnectionstatechange,
      this.onsignalingstatechange,
      this.onconnectionstatechange,
    ].filter((handler) => handler !== null).length;
  }
  getTransceivers(): Array<{ stop: () => void }> {
    return [];
  }
  createDataChannel(_label: string): RTCDataChannel {
    return {} as RTCDataChannel;
  }
  close(): void {
    this.connectionState = 'closed';
  }
  setLocalDescription(): Promise<void> {
    this.localDescription = { type: 'offer', sdp: 'offer-sdp' } as RTCSessionDescription;
    return Promise.resolve();
  }
}

if (import.meta.main) await main();
