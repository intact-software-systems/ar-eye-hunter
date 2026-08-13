import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import { deriveRtcBaselineCaptureManifest } from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type {
  RtcBaselineSampleFailureOutcomeArtifact,
  RtcBaselineSampleDto,
} from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import * as Diagnostics from '../../../workloads/signaling/rtc-peer-connection-diagnostics-burst.ts';
import { runRtcPeerConnectionDiagnostics } from '../../../workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts';
import * as IceQueue from '../../../workloads/signaling/rtc-ice-candidate-queue-bench.ts';
import * as Listeners from '../../../workloads/signaling/rtc-peer-listener-cleanup-bench.ts';

const baselineId = '20260807-0123456789ab-e1-local';
const denoPrefix = words(
  'run --config=packages/shared-rtc-bench/deno.json --allow-read --allow-write',
);

function words(value: string): string[] {
  return value.trim().split(/\s+/);
}

function signalingWorker(caseId: string, key: string, flags: string[], runs = 5) {
  const prefix = `rtc-b01-${caseId}-${key}-retained-001`;
  const ids = Array.from(
    { length: runs },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
  const arguments_ = words(`--capture=worker --baseline-id=${baselineId} --workload=RTC-B01
--case-id=${caseId} --input-key=${key} --intended-phase=retained --outer-ordinal=1
--sample-ids=${ids.join(',')}`);
  return { ids, arguments: [...arguments_, ...flags] };
}

type SignalingWorkerInput = ReturnType<typeof signalingWorker>;

function replaceArgument(arguments_: readonly string[], name: string, value: string): string[] {
  return arguments_.map((argument) =>
    argument.startsWith(`--${name}=`) ? `--${name}=${value}` : argument,
  );
}

function accepted<
  Result extends
    { readonly ok: false } | { readonly ok: true; readonly value: { readonly mode: string } },
>(
  result: Result,
): Extract<Extract<Result, { readonly ok: true }>['value'], { readonly mode: 'accepted' }> {
  if (!result.ok || result.value.mode !== 'accepted') {
    throw new Error('Expected exact worker.');
  }
  return result.value as Extract<
    Extract<Result, { readonly ok: true }>['value'],
    { readonly mode: 'accepted' }
  >;
}

function expectExactWorker(
  parse: (args: readonly string[]) => { readonly ok: boolean },
  input: SignalingWorkerInput,
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

interface FailureProbe {
  readonly input: SignalingWorkerInput;
  readonly execute: (noteExecution: () => void) => Promise<RtcBaselineSampleDto[]>;
}

function failureProbe<Result, Worker>(
  input: SignalingWorkerInput,
  invalid: Result,
  parsedWorker: Worker,
  runAccepted: (input: {
    readonly worker: Worker;
    readonly run: () => Promise<Result>;
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

async function expectStopsAfterFirstFailure(probes: readonly FailureProbe[]) {
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

async function persistSignalingFailure(caseId: string, outcomes: RtcBaselineSampleDto[]) {
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
  return {
    result: await acceptance.captureWorkload({ baselineId, workloadId: 'RTC-B01' }),
    writes,
  };
}

const burst = signalingWorker(
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
  expectExactWorker(Diagnostics.parseRtcPeerConnectionDiagnosticsArguments, burst, 'rtc-peers');
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
  const [outcomes] = await expectStopsAfterFirstFailure([
    failureProbe(
      burst,
      { ...result, diagnostics: { ...result.diagnostics, queuedIceCandidateCount: 2499 } },
      parsed,
      Diagnostics.runRtcPeerConnectionDiagnosticsAcceptedSamples,
    ),
  ]);
  const persisted = await persistSignalingFailure('peer-connection-diagnostics-burst', outcomes);
  expect(persisted.result).toMatchObject({ ok: false });
  expect(persisted.writes[0]).toMatchObject({
    artifactKind: 'failure',
    identity: { sampleId: burst.ids[0] },
    issues: [{ code: 'counter-mismatch' }],
  });
});

it('RTC-B01 accepts the fixed queue and listener matrices through the canonical runner', async () => {
  const queue = signalingWorker(
    'ice-candidate-queue',
    'candidates-25000',
    words('--rtc-candidates=25000 --rtc-inner-runs=5'),
  );
  const listeners = signalingWorker(
    'peer-listener-cleanup',
    'peers-10000',
    words('--rtc-inner-runs=5 --rtc-peers=10000'),
  );
  const samples = [
    ...(await IceQueue.runRtcIceCandidateQueueAcceptedSamples({
      worker: accepted(IceQueue.parseRtcIceCandidateQueueArguments(queue.arguments)),
      run: async () => ({
        durationMs: 1,
        candidateCount: 25000,
        addedCandidates: 25000,
        remainingQueuedCandidates: 0,
      }),
    })),
    ...(await Listeners.runRtcPeerListenerCleanupAcceptedSamples({
      worker: accepted(Listeners.parseRtcPeerListenerCleanupArguments(listeners.arguments)),
      run: async () => ({
        durationMs: 1,
        peerCount: 10000,
        retainedIceGatheringListeners: 0,
        maxListenersPerPeer: 0,
        unclearedHandlerSlots: 0,
      }),
    })),
  ];
  expect(
    samples.every(
      (sample) => sample.outcome === 'passed' && sample.evidenceClass === 'synthetic-path',
    ),
  ).toBe(true);
  expect(Object.keys(Diagnostics)).not.toContain('createRtcPeerConnectionDiagnosticsSamples');
  expect(Object.keys(IceQueue)).not.toContain('createRtcIceCandidateQueueSamples');
  expect(Object.keys(Listeners)).not.toContain('createRtcPeerListenerCleanupSamples');
});

it('RTC-B01 diagnostics stay create-new beneath tmp/perf/results', () => {
  mkdirSync('tmp/perf/results', { recursive: true });
  const directory = mkdtempSync(join('tmp/perf/results', 'rtc-signaling-diagnostic-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'ice-candidate-queue.json');
  const command = [
    ...denoPrefix,
    'packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts',
    '--candidates=1',
    '--runs=1',
    `--out=${output}`,
  ];
  expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
  const persisted = JSON.parse(readFileSync(output, 'utf8'));
  expect([persisted.schema, persisted.outcome]).toEqual([undefined, undefined]);
  expect(spawnSync('deno', command, { encoding: 'utf8' }).status).not.toBe(0);
});
