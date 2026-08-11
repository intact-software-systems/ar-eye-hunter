import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRtcPeerConnectionDiagnostics } from '../../../scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts';
import {
  createRtcIceCandidateQueueSamples,
  parseRtcIceCandidateQueueArguments,
} from '../../../scripts/perf/rtc-ice-candidate-queue-bench.ts';
import {
  createRtcPeerConnectionDiagnosticsDependencies,
  parseRtcPeerConnectionDiagnosticsArguments,
  runRtcPeerConnectionDiagnosticsAcceptedSamples,
} from '../../../scripts/perf/rtc-peer-connection-diagnostics-burst.ts';
import {
  createRtcPeerListenerCleanupSamples,
  parseRtcPeerListenerCleanupArguments,
} from '../../../scripts/perf/rtc-peer-listener-cleanup-bench.ts';
import { createRtcBaselineEvidenceAcceptance } from '../../../scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts';
import { deriveRtcBaselineCaptureManifest } from '../../../scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts';

const featureFiles = [
  'rtc-baseline-contracts.ts',
  'rtc-baseline-decoding.ts',
  'rtc-baseline-artifact-decoding.ts',
  'rtc-baseline-workload-catalog.ts',
  'rtc-baseline-workload-manifest.ts',
  'rtc-baseline-validation.ts',
  'rtc-baseline-artifact-validation.ts',
  'rtc-baseline-statistics.ts',
  'rtc-baseline-evidence-layout.ts',
  'rtc-baseline-evidence-store.ts',
  'rtc-baseline-failure-accounting.ts',
  'rtc-baseline-evidence-acceptance.ts',
  'rtc-baseline-finalized-evidence.ts',
  'rtc-baseline-finalized-reader.ts',
  'rtc-baseline-envelope.ts',
  'rtc-baseline-runtime-observation.ts',
  'rtc-baseline-deno-adapters.ts',
  'rtc-baseline-deno-runtime.ts',
  'rtc-baseline-cli-options.ts',
  'rtc-baseline-cli-grammar.ts',
  'rtc-baseline-cli.ts',
  'rtc-data-channel-drain-bench.ts',
  'rtc-rtt-repository-filter-bench.ts',
  'rtc-peer-connection-diagnostics-runtime.ts',
];

const repositoryTests = [
  'rtc-performance-baseline-contract.test.ts',
  'rtc-performance-baseline-decoding.test.ts',
  'rtc-performance-baseline-validation.test.ts',
  'rtc-performance-baseline-artifact-validation.test.ts',
  'rtc-performance-baseline-statistics.test.ts',
  'rtc-performance-baseline-workload-catalog.test.ts',
  'rtc-performance-baseline-workload-manifest.test.ts',
  'rtc-performance-baseline-evidence-acceptance.test.ts',
  'rtc-performance-baseline-evidence-failure.test.ts',
  'rtc-performance-baseline-evidence-store.test.ts',
  'rtc-performance-baseline-harnesses.test.ts',
  'rtc-performance-baseline-envelope.test.ts',
  'rtc-performance-baseline-finalization.test.ts',
  'rtc-performance-baseline-finalized-reader.test.ts',
  'rtc-performance-baseline-deno-adapters.test.ts',
  'rtc-performance-baseline-deno-runtime.test.ts',
  'rtc-performance-baseline-cli-grammar.test.ts',
  'rtc-performance-baseline-cli.test.ts',
];

const existingTypeScriptHarnesses = [
  'rtc-peer-connection-diagnostics-burst.ts',
  'rtc-ice-candidate-queue-bench.ts',
  'rtc-peer-listener-cleanup-bench.ts',
  'rtc-data-channel-replace-key-bench.ts',
  'rtc-data-channel-close-retention-bench.ts',
  'rtc-data-channel-error-reference-bench.ts',
  'rtc-topology-star-bench.ts',
  'rtc-topology-tree-no-rtt-bench.ts',
  'rtc-topology-mesh-no-rtt-bench.ts',
  'rtc-room-graph-rtt-bench.ts',
  'rtc-topology-inactive-churn-bench.ts',
  'rtc-multicast-serialization-bench.ts',
  'webrtc-group-cache-fallback-bench.ts',
  'webrtc-group-manager-state-bench.ts',
  'webrtc-group-manager-peer-owners-bench.ts',
  'webrtc-heartbeat-callback-churn-bench.ts',
];

const nodeSoak = ['rtc-data-channel-browser-soak.mjs'];

describe('RTC baseline reservation inventory', () => {
  it('retains the exact test-owned 24/18/16/1 inventory', () => {
    expect({ featureFiles, repositoryTests, existingTypeScriptHarnesses, nodeSoak }).toEqual({
      featureFiles: [
        'rtc-baseline-contracts.ts',
        'rtc-baseline-decoding.ts',
        'rtc-baseline-artifact-decoding.ts',
        'rtc-baseline-workload-catalog.ts',
        'rtc-baseline-workload-manifest.ts',
        'rtc-baseline-validation.ts',
        'rtc-baseline-artifact-validation.ts',
        'rtc-baseline-statistics.ts',
        'rtc-baseline-evidence-layout.ts',
        'rtc-baseline-evidence-store.ts',
        'rtc-baseline-failure-accounting.ts',
        'rtc-baseline-evidence-acceptance.ts',
        'rtc-baseline-finalized-evidence.ts',
        'rtc-baseline-finalized-reader.ts',
        'rtc-baseline-envelope.ts',
        'rtc-baseline-runtime-observation.ts',
        'rtc-baseline-deno-adapters.ts',
        'rtc-baseline-deno-runtime.ts',
        'rtc-baseline-cli-options.ts',
        'rtc-baseline-cli-grammar.ts',
        'rtc-baseline-cli.ts',
        'rtc-data-channel-drain-bench.ts',
        'rtc-rtt-repository-filter-bench.ts',
        'rtc-peer-connection-diagnostics-runtime.ts',
      ],
      repositoryTests: [
        'rtc-performance-baseline-contract.test.ts',
        'rtc-performance-baseline-decoding.test.ts',
        'rtc-performance-baseline-validation.test.ts',
        'rtc-performance-baseline-artifact-validation.test.ts',
        'rtc-performance-baseline-statistics.test.ts',
        'rtc-performance-baseline-workload-catalog.test.ts',
        'rtc-performance-baseline-workload-manifest.test.ts',
        'rtc-performance-baseline-evidence-acceptance.test.ts',
        'rtc-performance-baseline-evidence-failure.test.ts',
        'rtc-performance-baseline-evidence-store.test.ts',
        'rtc-performance-baseline-harnesses.test.ts',
        'rtc-performance-baseline-envelope.test.ts',
        'rtc-performance-baseline-finalization.test.ts',
        'rtc-performance-baseline-finalized-reader.test.ts',
        'rtc-performance-baseline-deno-adapters.test.ts',
        'rtc-performance-baseline-deno-runtime.test.ts',
        'rtc-performance-baseline-cli-grammar.test.ts',
        'rtc-performance-baseline-cli.test.ts',
      ],
      existingTypeScriptHarnesses: [
        'rtc-peer-connection-diagnostics-burst.ts',
        'rtc-ice-candidate-queue-bench.ts',
        'rtc-peer-listener-cleanup-bench.ts',
        'rtc-data-channel-replace-key-bench.ts',
        'rtc-data-channel-close-retention-bench.ts',
        'rtc-data-channel-error-reference-bench.ts',
        'rtc-topology-star-bench.ts',
        'rtc-topology-tree-no-rtt-bench.ts',
        'rtc-topology-mesh-no-rtt-bench.ts',
        'rtc-room-graph-rtt-bench.ts',
        'rtc-topology-inactive-churn-bench.ts',
        'rtc-multicast-serialization-bench.ts',
        'webrtc-group-cache-fallback-bench.ts',
        'webrtc-group-manager-state-bench.ts',
        'webrtc-group-manager-peer-owners-bench.ts',
        'webrtc-heartbeat-callback-churn-bench.ts',
      ],
      nodeSoak: ['rtc-data-channel-browser-soak.mjs'],
    });
  });

  it('excludes the three historical probes from accepted harnesses', () => {
    expect(existingTypeScriptHarnesses).not.toContain('rtc-room-graph-no-rtt-bench.ts');
    expect(existingTypeScriptHarnesses).not.toContain('rtc-rtt-group-scan-bench.ts');
    expect(existingTypeScriptHarnesses).not.toContain('rtc-topology-rtt-traffic-metrics.ts');
  });
});

const baselineId = '20260807-0123456789ab-e1-local';
function retainedSampleIds(caseInput: string): string[] {
  return [1, 2, 3, 4, 5].map(
    (inner) => `rtc-b01-${caseInput}-retained-001-${String(inner).padStart(3, '0')}`,
  );
}
const burstSampleIds = retainedSampleIds('peer-connection-diagnostics-burst-pairs-500');
const queueSampleIds = retainedSampleIds('ice-candidate-queue-candidates-25000');
const listenerSampleIds = retainedSampleIds('peer-listener-cleanup-peers-10000');

function workerArguments(caseId: string, inputKey: string, sampleIds: readonly string[]) {
  return [
    '--capture=worker',
    `--baseline-id=${baselineId}`,
    '--workload=RTC-B01',
    `--case-id=${caseId}`,
    `--input-key=${inputKey}`,
    '--intended-phase=retained',
    '--outer-ordinal=1',
    `--sample-ids=${sampleIds.join(',')}`,
  ];
}

const repeated = <T>(value: T): T[] => [value, value, value, value, value];
function parseExactWorkers() {
  return {
    burst: parseRtcPeerConnectionDiagnosticsArguments([
      ...workerArguments('peer-connection-diagnostics-burst', 'pairs-500', burstSampleIds),
      '--rtc-ice-candidates-per-peer=5',
      '--rtc-inner-runs=5',
      '--rtc-offer-collisions-per-peer=3',
      '--rtc-peers=500',
    ]),
    queue: parseRtcIceCandidateQueueArguments([
      ...workerArguments('ice-candidate-queue', 'candidates-25000', queueSampleIds),
      '--rtc-candidates=25000',
      '--rtc-inner-runs=5',
    ]),
    listeners: parseRtcPeerListenerCleanupArguments([
      ...workerArguments('peer-listener-cleanup', 'peers-10000', listenerSampleIds),
      '--rtc-inner-runs=5',
      '--rtc-peers=10000',
    ]),
  };
}

const zeroCleanup = {
  pendingIceCandidateQueueLength: 0,
  reconnectAttemptsInFlight: 0,
  activeReconnectTimerCount: 0,
  pendingTimerCount: 0,
};
const validBurstResult = {
  durationMs: 1,
  peerCount: 1000,
  signalingMessagesSent: 500,
  diagnostics: {
    queuedIceCandidateCount: 2500,
    flushedIceCandidateCount: 2500,
    offerCollisionCount: 1500,
    ignoredOfferCollisionCount: 1500,
    reconnectAttemptCount: 500,
    reconnectTimerAlreadyActiveCount: 500,
    reconnectExhaustedCount: 500,
    iceRestartCount: 500,
  },
  cleanup: zeroCleanup,
};

describe('RTC-B01 accepted signaling, ICE, and listener instrumentation', () => {
  it('rejects invalid diagnostic bounds and non-frozen accepted inputs', () => {
    expect(parseRtcPeerConnectionDiagnosticsArguments(['--peers=0'])).toMatchObject({ ok: false });
    expect(parseRtcIceCandidateQueueArguments(['--candidates=25001'])).toMatchObject({ ok: false });
    expect(parseRtcPeerListenerCleanupArguments(['--runs=6'])).toMatchObject({ ok: false });
    const invalidOut = ['--out=/tmp/result.json'];
    const rejected = { ok: false };
    expect(parseRtcPeerConnectionDiagnosticsArguments(invalidOut)).toMatchObject(rejected);
    expect(parseRtcIceCandidateQueueArguments(invalidOut)).toMatchObject(rejected);
    expect(parseRtcPeerListenerCleanupArguments(invalidOut)).toMatchObject(rejected);
    expect(
      parseRtcPeerConnectionDiagnosticsArguments([
        ...workerArguments('peer-connection-diagnostics-burst', 'pairs-500', burstSampleIds),
        '--rtc-ice-candidates-per-peer=5',
        '--rtc-inner-runs=5',
        '--rtc-offer-collisions-per-peer=3',
        '--rtc-peers=499',
      ]),
    ).toMatchObject({ ok: false });
  });
  it('recomputes signaling counters and exposes zero cleanup state from explicit fakes', async () => {
    const hadPeerConnection = Object.hasOwn(globalThis, 'RTCPeerConnection');
    const fakeRuntime = createRtcPeerConnectionDiagnosticsDependencies();
    try {
      const result = await runRtcPeerConnectionDiagnostics(
        { peers: 2, iceCandidatesPerPeer: 2, offerCollisionsPerPeer: 3 },
        fakeRuntime.dependencies,
      );
      expect(result).toMatchObject({
        peerCount: 4,
        signalingMessagesSent: 2,
        diagnostics: {
          queuedIceCandidateCount: 4,
          flushedIceCandidateCount: 4,
          offerCollisionCount: 6,
          ignoredOfferCollisionCount: 6,
          reconnectAttemptCount: 2,
          reconnectTimerAlreadyActiveCount: 2,
          reconnectExhaustedCount: 2,
          iceRestartCount: 2,
        },
        cleanup: zeroCleanup,
      });
    } finally {
      fakeRuntime.restore();
    }
    expect(Object.hasOwn(globalThis, 'RTCPeerConnection')).toBe(hadPeerConnection);
  });
  it('accepts exact B01 inputs and recomputes producer counters and identities', () => {
    const { burst, queue, listeners } = parseExactWorkers();
    if (!burst.ok || !queue.ok || !listeners.ok) throw new Error('Expected exact worker inputs.');
    const queueSamples = createRtcIceCandidateQueueSamples({
      worker: queue.value,
      results: repeated({
        durationMs: 1,
        candidateCount: 25000,
        addedCandidates: 25000,
        remainingQueuedCandidates: 0,
      }),
    });
    const listenerSamples = createRtcPeerListenerCleanupSamples({
      worker: listeners.value,
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
  it('persists a counter failure before returning the accepted failure', async () => {
    const { burst: worker } = parseExactWorkers();
    if (!worker.ok) throw new Error('Expected exact worker input.');
    const invalid = {
      ...validBurstResult,
      diagnostics: {
        ...validBurstResult.diagnostics,
        queuedIceCandidateCount: 2499,
      },
    };
    let executedRuns = 0;
    const outcomes = await runRtcPeerConnectionDiagnosticsAcceptedSamples({
      worker: worker.value,
      run: async () => {
        executedRuns += 1;
        return invalid;
      },
    });
    expect(executedRuns).toBe(1);
    expect(outcomes.map((sample) => sample.identity.sampleId)).toEqual(burstSampleIds);
    const writes: unknown[] = [];
    const manifest = deriveRtcBaselineCaptureManifest({
      schema: 'rallar.rtc-baseline.capture-request.v1',
      baselineId,
      workloadIds: ['RTC-B01'],
      environmentId: 'E1-local',
      retainedSampleMultiplier: 1,
      repeatLink: null,
      conditionalEnvironmentDecisions: [],
    });
    const attempt = manifest.outerAttempts.find(
      (value) =>
        value.caseId === 'peer-connection-diagnostics-burst' && value.intendedPhase === 'retained',
    )!;
    const acceptance = createRtcBaselineEvidenceAcceptance({
      initializeStore: async () => ({ ok: true as const, value: undefined }),
      readManifest: async () => ({
        ok: true as const,
        value: { ...manifest, outerAttempts: [attempt] },
      }),
      writeAcceptedArtifact: async (_acceptedBaselineId, artifact) => {
        writes.push(artifact);
        return { ok: true as const, value: undefined };
      },
      readStagedJson: async () => ({ ok: false as const, issues: [] }),
      runFreshWorker: async () => ({ outcomes }),
      reconcileAcceptedOperation: async () => [],
    });
    expect(await acceptance.captureWorkload({ baselineId, workloadId: 'RTC-B01' })).toMatchObject({
      ok: false,
    });
    expect(writes[0]).toMatchObject({
      artifactKind: 'failure',
      identity: { sampleId: burstSampleIds[0] },
      issues: [{ code: 'counter-mismatch' }],
    });
  });
  it('keeps create-new diagnostic JSON separate from accepted evidence', () => {
    mkdirSync('tmp/perf/results', { recursive: true });
    const directory = mkdtempSync(join('tmp/perf/results', 'rtc-b01-diagnostic-'));
    const outputPath = join(directory, 'ice.json');
    const command = [
      'run',
      '--config=apps/api-v1/deno.json',
      '--allow-read',
      '--allow-write',
      'scripts/perf/rtc-ice-candidate-queue-bench.ts',
      '--candidates=1',
      '--runs=1',
      `--out=${outputPath}`,
    ];
    try {
      const first = spawnSync('deno', command, { encoding: 'utf8' });
      const persisted = JSON.parse(readFileSync(outputPath, 'utf8'));
      const second = spawnSync('deno', command, { encoding: 'utf8' });
      expect(first.status).toBe(0);
      expect(persisted).toMatchObject({ input: { candidateCount: 1, runs: 1 } });
      expect(persisted).not.toHaveProperty('schema');
      expect(persisted).not.toHaveProperty('outcome');
      expect(second.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
