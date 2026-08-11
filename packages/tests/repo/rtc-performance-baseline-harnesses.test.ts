import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../../scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts';
import type {
  RtcBaselineAcceptedArtifact,
  RtcBaselineResult,
  RtcBaselineSampleDto,
} from '../../../scripts/perf/rtc-baseline/rtc-baseline-contracts.ts';
import * as DrainBench from '../../../scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts';
import { runRtcPeerConnectionDiagnostics } from '../../../scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts';
import { deriveRtcBaselineCaptureManifest } from '../../../scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts';
import * as CloseBench from '../../../scripts/perf/rtc-data-channel-close-retention-bench.ts';
import * as ErrorBench from '../../../scripts/perf/rtc-data-channel-error-reference-bench.ts';
import * as ReplaceBench from '../../../scripts/perf/rtc-data-channel-replace-key-bench.ts';
import * as IceQueueBench from '../../../scripts/perf/rtc-ice-candidate-queue-bench.ts';
import * as DiagnosticsBench from '../../../scripts/perf/rtc-peer-connection-diagnostics-burst.ts';
import * as ListenerBench from '../../../scripts/perf/rtc-peer-listener-cleanup-bench.ts';

const fileNames = (manifest: string): string[] => manifest.trim().split(/\s+/);
const baselineFeatureFiles = fileNames(`
contracts decoding artifact-decoding workload-catalog workload-manifest validation
artifact-validation statistics evidence-layout evidence-store failure-accounting evidence-acceptance
finalized-evidence finalized-reader envelope runtime-observation deno-adapters deno-runtime
cli-options cli-grammar cli`);
const featureFiles = [
  ...baselineFeatureFiles.map((name) => `rtc-baseline-${name}.ts`),
  'rtc-data-channel-drain-bench.ts',
  'rtc-rtt-repository-filter-bench.ts',
  'rtc-peer-connection-diagnostics-runtime.ts',
];
const repositoryTests = fileNames(`
contract decoding validation artifact-validation statistics workload-catalog workload-manifest
evidence-acceptance evidence-failure evidence-store harnesses envelope finalization finalized-reader
deno-adapters deno-runtime cli-grammar cli
`).map((name) => `rtc-performance-baseline-${name}.test.ts`);
const rtcHarnessFiles = fileNames(`
peer-connection-diagnostics-burst ice-candidate-queue-bench peer-listener-cleanup-bench
data-channel-replace-key-bench data-channel-close-retention-bench data-channel-error-reference-bench
topology-star-bench topology-tree-no-rtt-bench topology-mesh-no-rtt-bench room-graph-rtt-bench
topology-inactive-churn-bench multicast-serialization-bench
`).map((name) => `rtc-${name}.ts`);
const webRtcHarnessFiles = fileNames(`
group-cache-fallback-bench group-manager-state-bench group-manager-peer-owners-bench
heartbeat-callback-churn-bench
`).map((name) => `webrtc-${name}.ts`);
const existingTypeScriptHarnesses = [...rtcHarnessFiles, ...webRtcHarnessFiles];
const nodeSoak = ['rtc-data-channel-browser-soak.mjs'];
it('retains the exact RTC baseline test-owned 24/18/16/1 inventory and exclusions', () => {
  const inventory = [featureFiles, repositoryTests, existingTypeScriptHarnesses, nodeSoak];
  const inventoryHash = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
  expect(inventoryHash).toBe('c1f1b81f32fdb75a83648d6fbd06a109006889d8dd49232ab3a27fcdb847dbe1');
});
const baselineId = '20260807-0123456789ab-e1-local';
const denoPrefix = fileNames('run --config=apps/api-v1/deno.json --allow-read --allow-write');
const repeated = <T>(value: T): T[] => Array.from({ length: 5 }, () => value);
function workerArguments(caseId: string, inputKey: string, flags: readonly string[]) {
  const workload = caseId.startsWith('data-channel-') ? 'RTC-B02' : 'RTC-B01';
  const prefix = `rtc-${workload.slice(4).toLowerCase()}-${caseId}-${inputKey}-retained-001`;
  const ids = [1, 2, 3, 4, 5].map((inner) => `${prefix}-${String(inner).padStart(3, '0')}`);
  return {
    ids,
    arguments: [
      '--capture=worker',
      `--baseline-id=${baselineId}`,
      `--workload=${workload}`,
      `--case-id=${caseId}`,
      `--input-key=${inputKey}`,
      '--intended-phase=retained',
      '--outer-ordinal=1',
      `--sample-ids=${ids.join(',')}`,
      ...flags,
    ],
  };
}
function drainArguments(depth: 32 | 1000 | 5000) {
  return workerArguments('data-channel-drain', `depth-${depth}`, [
    '--rtc-high-watermark-bytes=1',
    '--rtc-inner-runs=5',
    '--rtc-low-watermark-bytes=0',
    '--rtc-overflow=replace-by-key',
    '--rtc-payload-bytes=256',
    `--rtc-queue-depth=${depth}`,
  ]);
}
function replaceArgument(arguments_: readonly string[], name: string, value: string): string[] {
  const prefix = `--${name}=`;
  return arguments_.map((argument) =>
    argument.startsWith(prefix) ? `${prefix}${value}` : argument,
  );
}
function requireAccepted<T extends { readonly mode: string }>(result: RtcBaselineResult<T>) {
  if (!result.ok || result.value.mode !== 'accepted') throw new Error('Expected exact worker.');
  return result.value as Extract<T, { readonly mode: 'accepted' }>;
}
async function runUntilFailure<T>(
  expectedIds: readonly string[],
  invalidResult: T,
  runAccepted: (run: () => Promise<T>) => Promise<RtcBaselineSampleDto[]>,
): Promise<RtcBaselineSampleDto[]> {
  let executions = 0;
  const samples = await runAccepted(async () => {
    executions += 1;
    return invalidResult;
  });
  expect(executions).toBe(1);
  expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
    [expectedIds[0], 'failed'],
    ...expectedIds.slice(1).map((id) => [id, 'not-run']),
  ]);
  expect(
    samples.slice(1).map((sample) => [sample.issues[0]?.code, sample.issues[0]?.message]),
  ).toEqual(expectedIds.slice(1).map(() => ['causal-not-run', expectedIds[0]]));
  return samples;
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
  if (attempt === undefined) throw new Error(`Missing retained ${caseId} attempt.`);
  const writes: RtcBaselineAcceptedArtifact[] = [];
  const acceptance = createRtcBaselineEvidenceAcceptance({
    initializeStore: async () => ({ ok: true as const, value: undefined }),
    readManifest: async () => ({
      ok: true as const,
      value: { ...manifest, outerAttempts: [attempt] },
    }),
    writeAcceptedArtifact: async (_id, artifact) => {
      writes.push(artifact);
      return { ok: true as const, value: undefined };
    },
    readStagedJson: async () => ({ ok: false as const, issues: [] }),
    runFreshWorker: async () => ({ outcomes }),
    reconcileAcceptedOperation: async () => [],
  });
  return { result: await acceptance.captureWorkload({ baselineId, workloadId }), writes };
}

const burst = workerArguments('peer-connection-diagnostics-burst', 'pairs-500', [
  '--rtc-ice-candidates-per-peer=5',
  '--rtc-inner-runs=5',
  '--rtc-offer-collisions-per-peer=3',
  '--rtc-peers=500',
]);
it('RTC-B01 rejects invalid bounds, paths, and accepted overrides', () => {
  const invalidDiagnostics = [
    [DiagnosticsBench.parseRtcPeerConnectionDiagnosticsArguments, ['--peers=0']],
    [IceQueueBench.parseRtcIceCandidateQueueArguments, ['--candidates=25001']],
    [ListenerBench.parseRtcPeerListenerCleanupArguments, ['--runs=6']],
  ] as const;
  for (const [parse, args] of invalidDiagnostics) {
    expect(parse(args)).toMatchObject({ ok: false });
    expect(parse(['--out=/tmp/result.json'])).toMatchObject({ ok: false });
  }
  expect(
    DiagnosticsBench.parseRtcPeerConnectionDiagnosticsArguments(
      replaceArgument(burst.arguments, 'rtc-peers', '499'),
    ),
  ).toMatchObject({ ok: false });
});
it('RTC-B01 preserves counters, cleanup, identities, and failure persistence', async () => {
  const fakeRuntime = DiagnosticsBench.createRtcPeerConnectionDiagnosticsDependencies();
  onTestFinished(fakeRuntime.restore);
  const valid = await runRtcPeerConnectionDiagnostics(
    { peers: 500, iceCandidatesPerPeer: 5, offerCollisionsPerPeer: 3 },
    fakeRuntime.dependencies,
  );
  expect([valid.peerCount, valid.signalingMessagesSent]).toEqual([1000, 500]);
  const counters = valid.diagnostics;
  expect([counters.queuedIceCandidateCount, counters.flushedIceCandidateCount]).toEqual([
    2500, 2500,
  ]);
  expect([counters.offerCollisionCount, counters.ignoredOfferCollisionCount]).toEqual([1500, 1500]);
  expect([counters.reconnectAttemptCount, counters.reconnectTimerAlreadyActiveCount]).toEqual([
    500, 500,
  ]);
  expect([counters.reconnectExhaustedCount, counters.iceRestartCount]).toEqual([500, 500]);
  expect(Object.values(valid.cleanup).every((value) => value === 0)).toBe(true);
  const invalid = {
    ...valid,
    diagnostics: { ...valid.diagnostics, queuedIceCandidateCount: 2499 },
  };
  const worker = requireAccepted(
    DiagnosticsBench.parseRtcPeerConnectionDiagnosticsArguments(burst.arguments),
  );
  const outcomes = await runUntilFailure(burst.ids, invalid, (run) =>
    DiagnosticsBench.runRtcPeerConnectionDiagnosticsAcceptedSamples({ worker, run }),
  );
  const persisted = await persistFailure('RTC-B01', 'peer-connection-diagnostics-burst', outcomes);
  expect(persisted.result).toMatchObject({ ok: false });
  expect(persisted.writes[0]).toMatchObject({
    artifactKind: 'failure',
    identity: { sampleId: burst.ids[0] },
    issues: [{ code: 'counter-mismatch' }],
  });
});
it('RTC-B01 accepts the fixed queue and listener matrices', () => {
  const queue = workerArguments('ice-candidate-queue', 'candidates-25000', [
    '--rtc-candidates=25000',
    '--rtc-inner-runs=5',
  ]);
  const listeners = workerArguments('peer-listener-cleanup', 'peers-10000', [
    '--rtc-inner-runs=5',
    '--rtc-peers=10000',
  ]);
  const parsedQueue = IceQueueBench.parseRtcIceCandidateQueueArguments(queue.arguments);
  const parsedListeners = ListenerBench.parseRtcPeerListenerCleanupArguments(listeners.arguments);
  if (!parsedQueue.ok || !parsedListeners.ok) throw new Error('Expected exact workers.');
  const queueSamples = IceQueueBench.createRtcIceCandidateQueueSamples({
    worker: parsedQueue.value,
    results: repeated({
      durationMs: 1,
      candidateCount: 25000,
      addedCandidates: 25000,
      remainingQueuedCandidates: 0,
    }),
  });
  const listenerSamples = ListenerBench.createRtcPeerListenerCleanupSamples({
    worker: parsedListeners.value,
    results: repeated({
      durationMs: 1,
      peerCount: 10000,
      retainedIceGatheringListeners: 0,
      maxListenersPerPeer: 0,
      unclearedHandlerSlots: 0,
    }),
  });
  expect(
    [...queueSamples, ...listenerSamples].every(
      (sample) => sample.outcome === 'passed' && sample.evidenceClass === 'synthetic-path',
    ),
  ).toBe(true);
});

const parseReplace = ReplaceBench.parseRtcDataChannelReplaceKeyArguments;
const parseDrain = DrainBench.parseRtcDataChannelDrainArguments;
const parseClose = CloseBench.parseRtcDataChannelCloseRetentionArguments;
const parseError = ErrorBench.parseRtcDataChannelErrorReferenceArguments;
const acceptedReplace = workerArguments('data-channel-replace-key', 'depth-32', [
  '--rtc-inner-runs=5',
  '--rtc-queue-depth=32',
  '--rtc-replacements=25000',
]);
const acceptedDrain = drainArguments(32);
const acceptedClose = workerArguments('data-channel-close-retention', 'queue-32', [
  '--rtc-inner-runs=5',
  '--rtc-queue-depth=32',
]);
const acceptedError = workerArguments('data-channel-error-reference', 'fixed', [
  '--rtc-inner-runs=5',
]);
const replaceWorker = requireAccepted(parseReplace(acceptedReplace.arguments));
const drainWorker = requireAccepted(parseDrain(acceptedDrain.arguments));
const closeWorker = requireAccepted(parseClose(acceptedClose.arguments));
const errorWorker = requireAccepted(parseError(acceptedError.arguments));
it('RTC-B02 accepts only the exact matrix and preserves diagnostic arguments', () => {
  for (const depth of [32, 1000, 5000]) {
    const replace = workerArguments('data-channel-replace-key', `depth-${depth}`, [
      '--rtc-inner-runs=5',
      `--rtc-queue-depth=${depth}`,
      '--rtc-replacements=25000',
    ]);
    expect(
      [parseReplace(replace.arguments), parseDrain(drainArguments(depth).arguments)].every(
        (result) => result.ok,
      ),
    ).toBe(true);
  }
  const rejected = [
    [parseReplace, acceptedReplace.arguments, 'rtc-queue-depth', '032'],
    [parseDrain, acceptedDrain.arguments, 'rtc-payload-bytes', '255'],
    [parseClose, acceptedClose.arguments, 'rtc-queue-depth', '032'],
    [parseError, acceptedError.arguments, 'rtc-inner-runs', '4'],
  ] as const;
  for (const [parse, arguments_, name, value] of rejected) {
    expect(parse(['--out=/tmp/result.json'])).toMatchObject({ ok: false });
    expect(parse(replaceArgument(arguments_, name, value))).toMatchObject({ ok: false });
  }
});
it('RTC-B02 bounds lifecycle evidence and stops every runner after its first failure', async () => {
  const payloadBytes = [0, 31, 999, 4999].map(
    (index) =>
      new TextEncoder().encode(DrainBench.createRtcDataChannelDrainPayload(index)).byteLength,
  );
  expect(payloadBytes).toEqual([256, 256, 256, 256]);
  let intervalRead = 0;
  const result = await DrainBench.runRtcDataChannelDrain(32, {
    nativeChannel: new DrainBench.RtcDataChannelDrainFakeNativeChannel(() => undefined),
    clock: {
      createdAtEpochMs: (index) => 1_700_000_000_000 + index,
      monotonicNow: () => (intervalRead++ === 0 ? 100 : 125),
    },
    payload: {
      create: (index) => {
        if (intervalRead !== 0) throw new Error('Payload construction entered the interval.');
        return DrainBench.createRtcDataChannelDrainPayload(index);
      },
      byteLength: (value) => new TextEncoder().encode(value).byteLength,
    },
  });
  expect(result).toMatchObject({ queueDepth: 32, queuedBeforeDrain: 32, queuedAfterDrain: 0 });
  expect(result.maximumQueuedItemCount).toBe(32);
  expect(result).toMatchObject({ sentBeforeDrain: 0, sentDuringDrain: 32, payloadBytes: 256 });
  expect(result.sentBytesDuringDrain).toBe(8192);
  expect(result.intervalStartedAtMs).toBe(100);
  expect(result.intervalCompletedAtMs).toBe(125);
  expect(result.drainDurationMs).toBe(25);
  expect(intervalRead).toBe(2);
  const replacement = await ReplaceBench.runRtcDataChannelReplaceKey(32, 25000);
  expect(replacement).toMatchObject({ queueDepth: 32, replacements: 25000, queuedItemCount: 32 });
  expect(replacement.sentCount).toBe(0);
  expect(replacement.counters).toMatchObject({ queued: 32, replaced: 25000 });
  const close = await CloseBench.runRtcDataChannelCloseRetention(32);
  expect(close.queuedBeforeClose).toBe(32);
  expect(close.queuedAfterNativeClose).toBe(0);
  expect(close.queuedAfterReconnect).toBe(0);
  expect(close.replacementSentCount).toBe(0);
  expect(close.staleFlushOnReconnect).toBe(false);
  const error = await ErrorBench.runRtcDataChannelErrorReference();
  expect(error.readyStateAfterError).toBeUndefined();
  expect(error.statusHasDataChannelAfterError).toBe(false);
  expect(error.attachedHandlerCountAfterError).toBe(0);
  const failures = await Promise.all([
    runUntilFailure(acceptedReplace.ids, { ...replacement, queuedItemCount: 31 }, (run) =>
      ReplaceBench.runRtcDataChannelReplaceKeyAcceptedSamples({ worker: replaceWorker, run }),
    ),
    runUntilFailure(
      acceptedDrain.ids,
      {
        ...result,
        queuedAfterDrain: 1,
        sentDuringDrain: 31,
        sentBytesDuringDrain: 7936,
      },
      (run) => DrainBench.runRtcDataChannelDrainAcceptedSamples({ worker: drainWorker, run }),
    ),
    runUntilFailure(acceptedClose.ids, { ...close, queuedAfterReconnect: 1 }, (run) =>
      CloseBench.runRtcDataChannelCloseRetentionAcceptedSamples({ worker: closeWorker, run }),
    ),
    runUntilFailure(acceptedError.ids, { ...error, attachedHandlerCountAfterError: 1 }, (run) =>
      ErrorBench.runRtcDataChannelErrorReferenceAcceptedSamples({ worker: errorWorker, run }),
    ),
  ]);
  const outcomes = failures[1];
  const persisted = await persistFailure('RTC-B02', 'data-channel-drain', outcomes);
  expect(persisted.result).toMatchObject({ ok: false });
  const failureArtifact = persisted.writes[0];
  if (failureArtifact?.artifactKind !== 'failure') throw new Error('Expected failure artifact.');
  expect(failureArtifact.identity).toMatchObject({ sampleId: acceptedDrain.ids[0] });
  for (let index = 1; index < acceptedDrain.ids.length; index += 1) {
    expect(persisted.writes[index]).toMatchObject({
      artifactKind: 'not-run',
      failureId: failureArtifact.failureId,
      causalFailureId: failureArtifact.failureId,
      identity: { sampleId: acceptedDrain.ids[index] },
      issues: [{ code: 'causal-not-run' }],
    });
  }
});
it('RTC-B02 keeps every diagnostic create-new file outside accepted evidence', () => {
  mkdirSync('tmp/perf/results', { recursive: true });
  const directory = mkdtempSync(join('tmp/perf/results', 'rtc-diagnostic-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    ['scripts/perf/rtc-ice-candidate-queue-bench.ts', '--candidates=1'],
    ['scripts/perf/rtc-data-channel-replace-key-bench.ts', '--queue-size=1', '--replacements=1'],
    ['scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts', '--queue-depth=32'],
    ['scripts/perf/rtc-data-channel-close-retention-bench.ts', '--queue-items=1'],
    ['scripts/perf/rtc-data-channel-error-reference-bench.ts'],
  ];
  for (const [index, arguments_] of cases.entries()) {
    const outputPath = join(directory, `${index}.json`);
    const command = [...denoPrefix, ...arguments_, '--runs=1', `--out=${outputPath}`];
    expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
    const persisted = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect([persisted.schema, persisted.outcome]).toEqual([undefined, undefined]);
    expect(spawnSync('deno', command, { encoding: 'utf8' }).status).not.toBe(0);
  }
});
