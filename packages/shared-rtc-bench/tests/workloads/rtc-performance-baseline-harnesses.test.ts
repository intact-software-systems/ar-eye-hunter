import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import type {
  RtcBaselineSampleFailureOutcomeArtifact,
  RtcBaselineSampleDto,
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import * as Drain from '../../workloads/data-channel/rtc-data-channel-drain-bench.ts';
import { runRtcPeerConnectionDiagnostics } from '../../workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts';
import * as Repository from '../../workloads/topology/rtc-rtt-repository-filter-bench.ts';
import { RTC_BASELINE_WORKLOAD_CATALOG } from '../../baseline/catalog/rtc-baseline-workload-catalog.ts';
import { deriveRtcBaselineCaptureManifest } from '../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import * as Close from '../../workloads/data-channel/rtc-data-channel-close-retention-bench.ts';
import * as ErrorReference from '../../workloads/data-channel/rtc-data-channel-error-reference-bench.ts';
import * as Replace from '../../workloads/data-channel/rtc-data-channel-replace-key-bench.ts';
import * as IceQueue from '../../workloads/signaling/rtc-ice-candidate-queue-bench.ts';
import * as Diagnostics from '../../workloads/signaling/rtc-peer-connection-diagnostics-burst.ts';
import * as Listeners from '../../workloads/signaling/rtc-peer-listener-cleanup-bench.ts';
import * as RttGraph from '../../workloads/topology/rtc-room-graph-rtt-bench.ts';
import * as Inactive from '../../workloads/topology/rtc-topology-inactive-churn-bench.ts';
import * as Mesh from '../../workloads/topology/rtc-topology-mesh-no-rtt-bench.ts';
import * as Star from '../../workloads/topology/rtc-topology-star-bench.ts';
import * as Tree from '../../workloads/topology/rtc-topology-tree-no-rtt-bench.ts';
import { SyntheticRtcRttRuntimeStateRepository } from '../../workloads/topology/synthetic-rtc-rtt-runtime-state-repository.ts';

const words = (value: string): string[] => value.trim().split(/\s+/);
const inventory = [
  words(`packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts
packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts
packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-decoding.ts
packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts
packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts
packages/shared-rtc-bench/baseline/contracts/rtc-baseline-validation.ts
packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-validation.ts
packages/shared-rtc-bench/baseline/evidence/rtc-baseline-statistics.ts
packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-layout.ts
packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-store.ts
packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-failure-accounting.ts
packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-evidence-acceptance.ts
packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-evidence.ts
packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-reader.ts
packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts
packages/shared-rtc-bench/baseline/runtime/rtc-baseline-runtime-observation.ts
packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-adapters.ts
packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-runtime.ts
packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-options.ts
packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts
packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts
packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts
packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts`),
  words(`packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-contract.test.ts
packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-decoding.test.ts
packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-validation.test.ts
packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-artifact-validation.test.ts
packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-statistics.test.ts
packages/shared-rtc-bench/tests/baseline/catalog/rtc-performance-baseline-workload-catalog.test.ts
packages/shared-rtc-bench/tests/baseline/catalog/rtc-performance-baseline-workload-manifest.test.ts
packages/shared-rtc-bench/tests/baseline/acceptance/rtc-performance-baseline-evidence-acceptance.test.ts
packages/shared-rtc-bench/tests/baseline/acceptance/rtc-performance-baseline-evidence-failure.test.ts
packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-evidence-store.test.ts
packages/shared-rtc-bench/tests/workloads/rtc-performance-baseline-harnesses.test.ts
packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-envelope.test.ts
packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-finalization.test.ts
packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-finalized-reader.test.ts
packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-deno-adapters.test.ts
packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-deno-runtime.test.ts
packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli-grammar.test.ts
packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli.test.ts`),
  words(`packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts
packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts
packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts
packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts
packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts
packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts
packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts
packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts
packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts
packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts
packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts
packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts`),
  ['packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs'],
];
const baselineId = '20260807-0123456789ab-e1-local';
const denoPrefix = words(
  'run --config=packages/shared-rtc-bench/deno.json --allow-read --allow-write',
);
type WorkloadId = 'RTC-B01' | 'RTC-B02' | 'RTC-B03';
const parseReplace = Replace.parseRtcDataChannelReplaceKeyArguments;
const parseDrain = Drain.parseRtcDataChannelDrainArguments;
const parseClose = Close.parseRtcDataChannelCloseRetentionArguments;
const parseError = ErrorReference.parseRtcDataChannelErrorReferenceArguments;
const sampleReplace = Replace.runRtcDataChannelReplaceKeyAcceptedSamples;
const sampleDrain = Drain.runRtcDataChannelDrainAcceptedSamples;
const sampleClose = Close.runRtcDataChannelCloseRetentionAcceptedSamples;
const sampleError = ErrorReference.runRtcDataChannelErrorReferenceAcceptedSamples;

function worker(workload: WorkloadId, caseId: string, key: string, flags: string[], runs = 5) {
  const prefix = `rtc-${workload.slice(4).toLowerCase()}-${caseId}-${key}-retained-001`;
  const ids = Array.from(
    { length: runs },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
  const arguments_ = words(`--capture=worker --baseline-id=${baselineId} --workload=${workload}
--case-id=${caseId} --input-key=${key} --intended-phase=retained --outer-ordinal=1
--sample-ids=${ids.join(',')}`);
  return { ids, arguments: [...arguments_, ...flags] };
}
function replaceArgument(arguments_: readonly string[], name: string, value: string): string[] {
  return arguments_.map((argument) =>
    argument.startsWith(`--${name}=`) ? `--${name}=${value}` : argument,
  );
}
function accepted<
  T extends
    { readonly ok: false } | { readonly ok: true; readonly value: { readonly mode: string } },
>(result: T): Extract<Extract<T, { readonly ok: true }>['value'], { readonly mode: 'accepted' }> {
  if (!result.ok || result.value.mode !== 'accepted') {
    throw new Error('Expected exact worker.');
  }
  return result.value as Extract<
    Extract<T, { readonly ok: true }>['value'],
    { readonly mode: 'accepted' }
  >;
}
function exactWorker(
  parse: (args: readonly string[]) => { readonly ok: boolean },
  input: ReturnType<typeof worker>,
  integer: string,
) {
  const argument = input.arguments.find((value) => value.startsWith(`--${integer}=`));
  if (argument === undefined) {
    throw new Error(`Missing ${integer}.`);
  }
  const value = argument.slice(argument.indexOf('=') + 1);
  const rejected = [
    replaceArgument(input.arguments, integer, '0'),
    replaceArgument(input.arguments, integer, `0${value}`),
    [...input.arguments, '--rtc-alias=1'],
    replaceArgument(input.arguments, 'sample-ids', input.ids[0]),
  ];
  expect([input.arguments, ...rejected].map((arguments_) => parse(arguments_).ok)).toEqual([
    true,
    ...Array(4).fill(false),
  ]);
}
type WorkerInput = ReturnType<typeof worker>;
interface FailureProbe {
  readonly input: WorkerInput;
  readonly execute: (noteExecution: () => void) => Promise<RtcBaselineSampleDto[]>;
}
function failureProbe<T, W>(
  input: WorkerInput,
  invalid: T,
  parsedWorker: W,
  runAccepted: (input: {
    readonly worker: W;
    readonly run: () => Promise<T>;
  }) => Promise<RtcBaselineSampleDto[]>,
): FailureProbe {
  return {
    input,
    execute: (noteExecution) =>
      runAccepted({
        worker: parsedWorker,
        run: async () => {
          noteExecution();
          return invalid;
        },
      }),
  };
}
async function expectStops(probes: readonly FailureProbe[]) {
  const outcomes: RtcBaselineSampleDto[][] = [];
  for (const probe of probes) {
    let executions = 0;
    const samples = await probe.execute(() => {
      executions += 1;
    });
    expect(executions).toBe(1);
    expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
      [probe.input.ids[0], 'failed'],
      ...probe.input.ids.slice(1).map((id) => [id, 'not-run']),
    ]);
    expect(
      samples.slice(1).map((sample) => [sample.issues[0]?.code, sample.issues[0]?.message]),
    ).toEqual(probe.input.ids.slice(1).map(() => ['causal-not-run', probe.input.ids[0]]));
    outcomes.push(samples);
  }
  return outcomes;
}
async function persistFailure(
  workloadId: 'RTC-B01' | 'RTC-B02',
  caseId: string,
  outcomes: RtcBaselineSampleDto[],
) {
  const manifest = deriveRtcBaselineCaptureManifest({
    schema: 'rallar.rtc-baseline.capture-request.v1',
    baselineId,
    workloadIds: [workloadId],
    environmentId: 'E1-local',
    retainedSampleMultiplier: 1,
    repeatLink: null,
    conditionalEnvironmentDecisions: [],
  });
  const attempt = manifest.outerAttempts.find(
    (value) => value.caseId === caseId && value.intendedPhase === 'retained',
  );
  if (attempt === undefined) {
    throw new Error(`Missing retained ${caseId} attempt.`);
  }
  const writes: RtcBaselineSampleFailureOutcomeArtifact[] = [];
  const acceptance = createRtcBaselineEvidenceAcceptance({
    initializeStore: async () => ({ ok: true as const, value: undefined }),
    readManifest: async () => ({
      ok: true as const,
      value: { ...manifest, outerAttempts: [attempt] },
    }),
    writeAcceptedArtifact: async (_id, artifact) => {
      if (
        !('artifactKind' in artifact) ||
        !('identity' in artifact) ||
        !('sampleId' in artifact.identity)
      ) {
        throw new Error('Expected a sample-owned failure outcome artifact.');
      }
      writes.push(artifact as RtcBaselineSampleFailureOutcomeArtifact);
      return { ok: true as const, value: undefined };
    },
    readStagedJson: async () => ({ ok: false as const, issues: [] }),
    runFreshWorker: async () => ({ outcomes }),
    reconcileAcceptedOperation: async () => [],
  });
  return { result: await acceptance.captureWorkload({ baselineId, workloadId }), writes };
}

it('RTC-B03 retains the exact relocated 24/18/16/1 inventory and exclusions', () => {
  expect(inventory.map((files) => files.length)).toEqual([24, 18, 16, 1]);
  expect(inventory.flat().every(existsSync)).toBe(true);
  const historical = words(
    'rtc-room-graph-no-rtt-bench.ts rtc-rtt-group-scan-bench.ts rtc-topology-rtt-traffic-metrics.ts',
  );
  expect(inventory.flat()).not.toEqual(expect.arrayContaining(historical));
  const acceptedPaths = RTC_BASELINE_WORKLOAD_CATALOG.flatMap((workload) =>
    workload.cases.flatMap((case_) => case_.sourcePaths),
  );
  expect(acceptedPaths).not.toEqual(
    expect.arrayContaining(historical.map((name) => `scripts/perf/${name}`)),
  );
});

const burst = worker(
  'RTC-B01',
  'peer-connection-diagnostics-burst',
  'pairs-500',
  words(
    '--rtc-ice-candidates-per-peer=5 --rtc-inner-runs=5 --rtc-offer-collisions-per-peer=3 --rtc-peers=500',
  ),
);
it('RTC-B01 rejects invalid bounds, paths, and accepted overrides', () => {
  for (const [parse, arguments_] of [
    [Diagnostics.parseRtcPeerConnectionDiagnosticsArguments, ['--peers=0']],
    [IceQueue.parseRtcIceCandidateQueueArguments, ['--candidates=25001']],
    [Listeners.parseRtcPeerListenerCleanupArguments, ['--runs=6']],
  ] as const) {
    expect(parse(arguments_)).toMatchObject({ ok: false });
    expect(parse(['--out=/tmp/result.json'])).toMatchObject({ ok: false });
  }
  exactWorker(Diagnostics.parseRtcPeerConnectionDiagnosticsArguments, burst, 'rtc-peers');
});
it('RTC-B01 preserves counters, cleanup, identities, and failure persistence', async () => {
  const runtime = Diagnostics.createRtcPeerConnectionDiagnosticsDependencies();
  onTestFinished(runtime.restore);
  const result = await runRtcPeerConnectionDiagnostics(
    { peers: 500, iceCandidatesPerPeer: 5, offerCollisionsPerPeer: 3 },
    runtime.dependencies,
  );
  expect([result.peerCount, result.signalingMessagesSent]).toEqual([1000, 500]);
  expect([
    result.diagnostics.queuedIceCandidateCount,
    result.diagnostics.flushedIceCandidateCount,
    result.diagnostics.offerCollisionCount,
    result.diagnostics.ignoredOfferCollisionCount,
    result.diagnostics.reconnectAttemptCount,
    result.diagnostics.reconnectTimerAlreadyActiveCount,
    result.diagnostics.reconnectExhaustedCount,
    result.diagnostics.iceRestartCount,
  ]).toEqual([2500, 2500, 1500, 1500, 500, 500, 500, 500]);
  expect(Object.values(result.cleanup).every((value) => value === 0)).toBe(true);
  const parsed = accepted(Diagnostics.parseRtcPeerConnectionDiagnosticsArguments(burst.arguments));
  const [outcomes] = await expectStops([
    failureProbe(
      burst,
      { ...result, diagnostics: { ...result.diagnostics, queuedIceCandidateCount: 2499 } },
      parsed,
      Diagnostics.runRtcPeerConnectionDiagnosticsAcceptedSamples,
    ),
  ]);
  const persisted = await persistFailure('RTC-B01', 'peer-connection-diagnostics-burst', outcomes);
  expect(persisted.result).toMatchObject({ ok: false });
  expect(persisted.writes[0]).toMatchObject({
    artifactKind: 'failure',
    identity: { sampleId: burst.ids[0] },
    issues: [{ code: 'counter-mismatch' }],
  });
});
it('RTC-B01 accepts the fixed queue and listener matrices', () => {
  const queue = worker(
    'RTC-B01',
    'ice-candidate-queue',
    'candidates-25000',
    words('--rtc-candidates=25000 --rtc-inner-runs=5'),
  );
  const listeners = worker(
    'RTC-B01',
    'peer-listener-cleanup',
    'peers-10000',
    words('--rtc-inner-runs=5 --rtc-peers=10000'),
  );
  const samples = [
    ...IceQueue.createRtcIceCandidateQueueSamples({
      worker: accepted(IceQueue.parseRtcIceCandidateQueueArguments(queue.arguments)),
      results: Array(5).fill({
        durationMs: 1,
        candidateCount: 25000,
        addedCandidates: 25000,
        remainingQueuedCandidates: 0,
      }),
    }),
    ...Listeners.createRtcPeerListenerCleanupSamples({
      worker: accepted(Listeners.parseRtcPeerListenerCleanupArguments(listeners.arguments)),
      results: Array(5).fill({
        durationMs: 1,
        peerCount: 10000,
        retainedIceGatheringListeners: 0,
        maxListenersPerPeer: 0,
        unclearedHandlerSlots: 0,
      }),
    }),
  ];
  expect(
    samples.every(
      (sample) => sample.outcome === 'passed' && sample.evidenceClass === 'synthetic-path',
    ),
  ).toBe(true);
});

const drainInput = (depth: 32 | 1000 | 5000) =>
  worker(
    'RTC-B02',
    'data-channel-drain',
    `depth-${depth}`,
    words(`--rtc-high-watermark-bytes=1 --rtc-inner-runs=5
--rtc-low-watermark-bytes=0 --rtc-overflow=replace-by-key --rtc-payload-bytes=256
--rtc-queue-depth=${depth}`),
  );
const b02 = {
  replace: worker(
    'RTC-B02',
    'data-channel-replace-key',
    'depth-32',
    words('--rtc-inner-runs=5 --rtc-queue-depth=32 --rtc-replacements=25000'),
  ),
  drain: drainInput(32),
  close: worker(
    'RTC-B02',
    'data-channel-close-retention',
    'queue-32',
    words('--rtc-inner-runs=5 --rtc-queue-depth=32'),
  ),
  error: worker('RTC-B02', 'data-channel-error-reference', 'fixed', words('--rtc-inner-runs=5')),
};
it('RTC-B02 accepts only the exact matrix and preserves diagnostic arguments', () => {
  for (const depth of [32, 1000, 5000] as const) {
    const replace = worker(
      'RTC-B02',
      'data-channel-replace-key',
      `depth-${depth}`,
      words(`--rtc-inner-runs=5 --rtc-queue-depth=${depth} --rtc-replacements=25000`),
    );
    expect(parseReplace(replace.arguments).ok).toBe(true);
    expect(parseDrain(drainInput(depth).arguments).ok).toBe(true);
  }
  for (const [parse, input, name, value] of [
    [parseReplace, b02.replace, 'rtc-queue-depth', '032'],
    [parseDrain, b02.drain, 'rtc-payload-bytes', '255'],
    [parseClose, b02.close, 'rtc-queue-depth', '032'],
    [parseError, b02.error, 'rtc-inner-runs', '4'],
  ] as const) {
    expect(parse(['--out=/tmp/result.json'])).toMatchObject({ ok: false });
    expect(parse(replaceArgument(input.arguments, name, value))).toMatchObject({ ok: false });
  }
});
it('RTC-B02 bounds lifecycle evidence and stops every runner after its first failure', async () => {
  expect(
    [0, 31, 999, 4999].map(
      (index) => new TextEncoder().encode(Drain.createRtcDataChannelDrainPayload(index)).byteLength,
    ),
  ).toEqual([256, 256, 256, 256]);
  let reads = 0;
  const drain = await Drain.runRtcDataChannelDrain(32, {
    nativeChannel: new Drain.RtcDataChannelDrainFakeNativeChannel(() => undefined),
    clock: {
      createdAtEpochMs: (index) => 1_700_000_000_000 + index,
      monotonicNow: () => (reads++ === 0 ? 100 : 125),
    },
    payload: {
      create: (index) => {
        if (reads !== 0) {
          throw new Error('Payload entered interval.');
        }
        return Drain.createRtcDataChannelDrainPayload(index);
      },
      byteLength: (value) => new TextEncoder().encode(value).byteLength,
    },
  });
  expect([
    drain.queueDepth,
    drain.queuedBeforeDrain,
    drain.queuedAfterDrain,
    drain.maximumQueuedItemCount,
    drain.sentBeforeDrain,
    drain.sentDuringDrain,
    drain.payloadBytes,
    drain.sentBytesDuringDrain,
    drain.intervalStartedAtMs,
    drain.intervalCompletedAtMs,
    drain.drainDurationMs,
    drain.highWatermarkBytes,
    drain.lowWatermarkBytes,
    drain.overflow,
  ]).toEqual([32, 32, 0, 32, 0, 32, 256, 8192, 100, 125, 25, 1, 0, 'replace-by-key']);
  expect(reads).toBe(2);
  const replacement = await Replace.runRtcDataChannelReplaceKey(32, 25000);
  const close = await Close.runRtcDataChannelCloseRetention(32);
  const error = await ErrorReference.runRtcDataChannelErrorReference();
  expect([
    replacement.queueDepth,
    replacement.replacements,
    replacement.queuedItemCount,
    replacement.sentCount,
  ]).toEqual([32, 25000, 32, 0]);
  expect([replacement.counters.queued, replacement.counters.replaced]).toEqual([32, 25000]);
  expect([
    close.queuedBeforeClose,
    close.queuedAfterNativeClose,
    close.queuedAfterReconnect,
    close.replacementSentCount,
    close.staleFlushOnReconnect,
  ]).toEqual([32, 0, 0, 0, false]);
  expect([
    error.readyStateAfterError,
    error.statusHasDataChannelAfterError,
    error.attachedHandlerCountAfterError,
  ]).toEqual([undefined, false, 0]);
  const failures = await expectStops([
    failureProbe(
      b02.replace,
      { ...replacement, queuedItemCount: 31 },
      accepted(parseReplace(b02.replace.arguments)),
      sampleReplace,
    ),
    failureProbe(
      b02.drain,
      { ...drain, queuedAfterDrain: 1, sentDuringDrain: 31, sentBytesDuringDrain: 7936 },
      accepted(parseDrain(b02.drain.arguments)),
      sampleDrain,
    ),
    failureProbe(
      b02.close,
      { ...close, queuedAfterReconnect: 1 },
      accepted(parseClose(b02.close.arguments)),
      sampleClose,
    ),
    failureProbe(
      b02.error,
      { ...error, attachedHandlerCountAfterError: 1 },
      accepted(parseError(b02.error.arguments)),
      sampleError,
    ),
  ]);
  const persisted = await persistFailure('RTC-B02', 'data-channel-drain', failures[1]);
  const failure = persisted.writes[0];
  expect(persisted.result).toMatchObject({ ok: false });
  if (failure?.artifactKind !== 'failure') {
    throw new Error('Expected failure artifact.');
  }
  expect(
    persisted.writes.map((artifact) => [
      artifact.artifactKind,
      artifact.identity.sampleId,
      artifact.artifactKind === 'not-run' ? artifact.failureId : undefined,
      artifact.artifactKind === 'not-run' ? artifact.causalFailureId : undefined,
      artifact.issues[0]?.code,
    ]),
  ).toEqual([
    ['failure', b02.drain.ids[0], undefined, undefined, 'queue-bound-mismatch'],
    ...b02.drain.ids
      .slice(1)
      .map((id) => ['not-run', id, failure.failureId, failure.failureId, 'causal-not-run']),
  ]);
});

interface Graph {
  readonly sessionIds: readonly string[];
  readonly edgePairs: readonly (readonly [string, string])[];
}

function sessionId(index: number): string {
  return `session-${String(index).padStart(3, '0')}`;
}

function sessionIds(sessions: number): string[] {
  return Array.from({ length: sessions }, (_value, index) => sessionId(index));
}

function orderedPair(left: number, right: number): readonly [string, string] {
  return left < right ? [sessionId(left), sessionId(right)] : [sessionId(right), sessionId(left)];
}

function completePairs(sessions: number): string[] {
  const pairs = [];
  for (let from = 0; from < sessions; from += 1) {
    for (let to = from + 1; to < sessions; to += 1) {
      pairs.push(`${sessionId(from)}::${sessionId(to)}`);
    }
  }
  return pairs;
}

function sparsePairs(sessions: number): string[] {
  const pairs = new Set<string>();
  for (let index = 0; index < sessions; index += 1) {
    for (const offset of [1, 2]) {
      pairs.add(orderedPair(index, (index + offset) % sessions).join('::'));
    }
  }
  return [...pairs].sort();
}

function disconnectedTreePairs(): Array<readonly [string, string]> {
  return Array.from({ length: 29 }, (_value, index) => orderedPair(index, (index + 1) % 29));
}

function disconnectedMeshPairs(): Array<readonly [string, string]> {
  const cycles: Array<readonly [string, string]> = [];
  const extra: Array<readonly [string, string]> = [];
  for (const start of [0, 15]) {
    for (let local = 0; local < 15; local += 1) {
      cycles.push(orderedPair(start + local, start + ((local + 1) % 15)));
      extra.push(orderedPair(start + local, start + ((local + 2) % 15)));
    }
  }
  return [...cycles, ...extra.slice(0, 27)];
}

function expectGraph(graph: Graph, edgeCount: number, maximumDegree: number) {
  const neighbors = new Map(graph.sessionIds.map((id) => [id, new Set<string>()]));
  expect(graph.edgePairs).toHaveLength(edgeCount);
  expect(new Set(graph.edgePairs.map(([from, to]) => `${from}::${to}`)).size).toBe(edgeCount);
  for (const [from, to] of graph.edgePairs) {
    expect(from < to).toBe(true);
    expect(neighbors.has(from) && neighbors.has(to)).toBe(true);
    neighbors.get(from)?.add(to);
    neighbors.get(to)?.add(from);
  }
  expect([...neighbors.values()].every((peers) => peers.size <= maximumDegree)).toBe(true);
  const visited = new Set<string>();
  const pending = [graph.sessionIds[0]];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    pending.push(...(neighbors.get(id) ?? []));
  }
  expect(visited.size).toBe(graph.sessionIds.length);
}
const b03Worker = (caseId: string, inputKey: string, flags: string[], runs = 5) =>
  worker('RTC-B03', caseId, inputKey, flags, runs);
it('RTC-B03 accepts the exact graph and inactive matrices with deterministic evidence', async () => {
  const failureProbes: FailureProbe[] = [];
  const graphCases = [
    [Star.parseRtcTopologyStarArguments, 'topology-star', ''],
    [Tree.parseRtcTopologyTreeArguments, 'topology-tree', '--rtc-degree-limit=5'],
    [Mesh.parseRtcTopologyMeshArguments, 'topology-mesh', '--rtc-mesh-param-k=2'],
    [RttGraph.parseRtcRoomGraphRttArguments, 'room-graph-rtt-sparse', '--rtc-sparse-degree=4'],
    [RttGraph.parseRtcRoomGraphRttArguments, 'room-graph-rtt-complete', ''],
  ] as const;
  for (const sessions of [30, 100, 300]) {
    for (const [parse, caseId, extra] of graphCases) {
      exactWorker(
        parse,
        b03Worker(
          caseId,
          `sessions-${sessions}`,
          words(`${extra} --rtc-inner-runs=5 --rtc-sessions=${sessions}`),
        ),
        'rtc-sessions',
      );
    }
    const star = Star.runRtcTopologyStar(sessions);
    const tree = Tree.runRtcTopologyTree(sessions, 5);
    const mesh = Mesh.runRtcTopologyMesh(sessions, 2);
    const sparse = RttGraph.runRtcRoomGraphRtt(sessions, 'sparse', 4);
    const complete = RttGraph.runRtcRoomGraphRtt(sessions, 'complete', 4);
    const expectedSessionIds = sessionIds(sessions);
    expect(star.sessionIds).toEqual(expectedSessionIds);
    expect(tree.sessionIds).toEqual(expectedSessionIds);
    expect(mesh.sessionIds).toEqual(expectedSessionIds);
    expectGraph(star, (sessions * (sessions - 1)) / 2, sessions - 1);
    expectGraph(tree, sessions - 1, 5);
    expectGraph(mesh, sessions * 2 - 3, 5);
    for (const graph of [sparse, complete]) {
      expectGraph(graph, graph.edgePairs.length, 5);
    }
    expectGraph(
      {
        sessionIds: sparse.sessionIds,
        edgePairs: sparse.measurements.map(
          (value) => [value.sessionIdFrom, value.sessionIdTo] as const,
        ),
      },
      sessions * 2,
      4,
    );
    expect(
      sparse.measurements.map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`),
    ).toEqual(sparsePairs(sessions));
    expect(
      complete.measurements.map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`),
    ).toEqual(completePairs(sessions));
    for (const graph of [sparse, complete]) {
      expect(
        graph.measurements.every((value, index, all) => {
          const from = Number(value.sessionIdFrom.slice(8));
          const to = Number(value.sessionIdTo.slice(8));
          return (
            value.rttMs === 5 + ((from * 31 + to * 17) % 96) &&
            (index === 0 || all[index - 1].version < value.version)
          );
        }),
      ).toBe(true);
    }
  }
  {
    const star = Star.runRtcTopologyStar(30);
    const tree = Tree.runRtcTopologyTree(30, 5);
    const mesh = Mesh.runRtcTopologyMesh(30, 2);
    const sparse = RttGraph.runRtcRoomGraphRtt(30, 'sparse', 4);
    const complete = RttGraph.runRtcRoomGraphRtt(30, 'complete', 4);
    const starInput = b03Worker(
      'topology-star',
      'sessions-30',
      words('--rtc-inner-runs=5 --rtc-sessions=30'),
    );
    const treeInput = b03Worker(
      'topology-tree',
      'sessions-30',
      words('--rtc-degree-limit=5 --rtc-inner-runs=5 --rtc-sessions=30'),
    );
    const meshInput = b03Worker(
      'topology-mesh',
      'sessions-30',
      words('--rtc-inner-runs=5 --rtc-mesh-param-k=2 --rtc-sessions=30'),
    );
    const sparseInput = b03Worker(
      'room-graph-rtt-sparse',
      'sessions-30',
      words('--rtc-inner-runs=5 --rtc-sessions=30 --rtc-sparse-degree=4'),
    );
    const completeInput = b03Worker(
      'room-graph-rtt-complete',
      'sessions-30',
      words('--rtc-inner-runs=5 --rtc-sessions=30'),
    );
    failureProbes.push(
      failureProbe(
        starInput,
        { ...star, edgePairs: Array(435).fill(star.edgePairs[0]) },
        accepted(Star.parseRtcTopologyStarArguments(starInput.arguments)),
        Star.runRtcTopologyStarAcceptedSamples,
      ),
      failureProbe(
        treeInput,
        { ...tree, edgePairs: disconnectedTreePairs() },
        accepted(Tree.parseRtcTopologyTreeArguments(treeInput.arguments)),
        Tree.runRtcTopologyTreeAcceptedSamples,
      ),
      failureProbe(
        meshInput,
        { ...mesh, edgePairs: disconnectedMeshPairs() },
        accepted(Mesh.parseRtcTopologyMeshArguments(meshInput.arguments)),
        Mesh.runRtcTopologyMeshAcceptedSamples,
      ),
      failureProbe(
        sparseInput,
        { ...sparse, edgePairs: [['foreign-a', 'foreign-b'], ...sparse.edgePairs.slice(1)] },
        accepted(RttGraph.parseRtcRoomGraphRttArguments(sparseInput.arguments)),
        RttGraph.runRtcRoomGraphRttAcceptedSamples,
      ),
      failureProbe(
        completeInput,
        { ...complete, edgePairs: [['foreign-a', 'foreign-b'], ...complete.edgePairs.slice(1)] },
        accepted(RttGraph.parseRtcRoomGraphRttArguments(completeInput.arguments)),
        RttGraph.runRtcRoomGraphRttAcceptedSamples,
      ),
    );
  }
  for (const mode of ['retain', 'cleanup'] as const) {
    const input = b03Worker(
      'topology-inactive-churn',
      `mode-${mode}`,
      words(`--rtc-groups=10000 --rtc-inner-runs=3 --rtc-mode=${mode} --rtc-sessions-per-group=5`),
      3,
    );
    exactWorker(Inactive.parseRtcTopologyInactiveChurnArguments, input, 'rtc-groups');
    const removed = mode === 'cleanup' ? 10000 : 0;
    const result = Inactive.runRtcTopologyInactiveChurn(10000, 5, mode);
    expect(result).toMatchObject({
      sessionIdsPerGroup: [
        'session-000',
        'session-001',
        'session-002',
        'session-003',
        'session-004',
      ],
      finalTopologySnapshotCount: 10000 - removed,
      topologyRemovalRequestCount: removed,
      topologyRemovedCount: removed,
      topologyRemoveMissCount: 0,
    });
    if (mode === 'retain') {
      failureProbes.push(
        failureProbe(
          input,
          { ...result, finalTopologySnapshotCount: 0 },
          accepted(Inactive.parseRtcTopologyInactiveChurnArguments(input.arguments)),
          Inactive.runRtcTopologyInactiveChurnAcceptedSamples,
        ),
      );
    }
  }
  await expectStops(failureProbes);
});
it('RTC-B03 filters every repository size without writes or foreign sessions', async () => {
  for (const roomSessions of [5, 30]) {
    for (const globalMeasurements of [1000, 10000, 100000]) {
      const input = b03Worker(
        'rtt-repository-filter',
        `room-${roomSessions}-global-${globalMeasurements}`,
        words(
          `--rtc-global-measurements=${globalMeasurements} --rtc-inner-runs=5 --rtc-room-sessions=${roomSessions}`,
        ),
      );
      exactWorker(
        Repository.parseRtcRttRepositoryFilterArguments,
        input,
        'rtc-global-measurements',
      );
      const runtimeRepository = new SyntheticRtcRttRuntimeStateRepository();
      let reads = 0;
      const result = await Repository.runRtcRttRepositoryFilter(
        { roomSessions, globalMeasurements },
        { runtimeRepository, clock: { nowEpochMs: () => 1000, monotonicNow: () => reads++ * 10 } },
      );
      const expected = completePairs(roomSessions);
      expect(result).toMatchObject({
        durationMs: 10,
        targetPairIdentities: expected,
        returnedPairIdentities: expected,
        repositoryCounts: { before: globalMeasurements, after: globalMeasurements },
      });
      expect(result.foreignPairIdentities).toHaveLength(globalMeasurements - expected.length);
      expect(
        result.returnedPairIdentities.every((pair) =>
          pair.split('::').every((id) => Number(id.slice(8)) < roomSessions),
        ),
      ).toBe(true);
      const stored = [...runtimeRepository.data.values()].map((entry) => JSON.parse(entry.value));
      expect(
        stored
          .slice(0, expected.length)
          .map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`),
      ).toEqual(expected);
      expect(
        stored
          .slice(expected.length)
          .map((value) => `${value.sessionIdFrom}::${value.sessionIdTo}`),
      ).toEqual(result.foreignPairIdentities);
      const lexicographic = [...stored].sort((left, right) =>
        `${left.sessionIdFrom}::${left.sessionIdTo}`.localeCompare(
          `${right.sessionIdFrom}::${right.sessionIdTo}`,
        ),
      );
      expect(
        lexicographic.every(
          (value, index, all) =>
            value.rttMs ===
              5 +
                ((Number(value.sessionIdFrom.slice(8)) * 31 +
                  Number(value.sessionIdTo.slice(8)) * 17) %
                  96) &&
            (index === 0 || all[index - 1].version < value.version),
        ),
      ).toBe(true);
      if (roomSessions === 5 && globalMeasurements === 1000) {
        const parsed = accepted(Repository.parseRtcRttRepositoryFilterArguments(input.arguments));
        const duplicates = Array(expected.length).fill(expected[0]);
        await expectStops([
          failureProbe(
            input,
            { ...result, targetPairIdentities: duplicates, returnedPairIdentities: duplicates },
            parsed,
            Repository.runRtcRttRepositoryFilterAcceptedSamples,
          ),
        ]);
      }
    }
  }
});

it('RTC-B02/RTC-B03 diagnostics stay create-new beneath tmp/perf/results', () => {
  mkdirSync('tmp/perf/results', { recursive: true });
  const directory = mkdtempSync(join('tmp/perf/results', 'rtc-diagnostic-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    [
      'packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts',
      '--candidates=1',
    ],
    [
      'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
      '--queue-size=1',
      '--replacements=1',
    ],
    [
      'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts',
      '--queue-depth=32',
    ],
    [
      'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
      '--queue-items=1',
    ],
    ['packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts'],
    ['packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts', '--sessions=30'],
    [
      'packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts',
      '--sessions=30',
      '--degree-limit=5',
    ],
    [
      'packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts',
      '--sessions=30',
      '--mesh-param-k=2',
    ],
    ['packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts', '--sessions=30'],
    [
      'packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts',
      '--groups=1',
      '--sessions=1',
    ],
    [
      'packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts',
      '--room-sessions=5',
      '--global-measurements=1000',
    ],
  ];
  for (const [index, arguments_] of cases.entries()) {
    const output = join(directory, `${index}.json`);
    const command = [...denoPrefix, ...arguments_, '--runs=1', `--out=${output}`];
    expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
    const persisted = JSON.parse(readFileSync(output, 'utf8'));
    expect([persisted.schema, persisted.outcome]).toEqual([undefined, undefined]);
    expect(spawnSync('deno', command, { encoding: 'utf8' }).status).not.toBe(0);
  }
}, 30_000);
