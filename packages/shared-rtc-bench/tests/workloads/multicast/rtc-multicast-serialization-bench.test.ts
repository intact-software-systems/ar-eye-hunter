import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import type { RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import * as Multicast from '../../../workloads/multicast/rtc-multicast-serialization-bench.ts';

const baselineId = '20260807-0123456789ab-e1-local';

function words(value: string): string[] {
  return value.trim().split(/\s+/);
}

function worker(peers: 10 | 100 | 1000, payloadBytes: 4096 | 65536) {
  const inputKey = `peers-${peers}-payload-${payloadBytes}`;
  const prefix = `rtc-b04-multicast-serialization-${inputKey}-retained-001`;
  const ids = Array.from(
    { length: 5 },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`,
  );
  return {
    ids,
    arguments: words(`--capture=worker --baseline-id=${baselineId} --workload=RTC-B04
--case-id=multicast-serialization --input-key=${inputKey} --intended-phase=retained
--outer-ordinal=1 --sample-ids=${ids.join(',')} --rtc-inner-runs=5 --rtc-peers=${peers}
--rtc-payload-bytes=${payloadBytes}`),
  };
}

function validAcceptedResult(
  peers: 10 | 100 | 1000,
  payloadBytes: 4096 | 65536,
): Multicast.RtcMulticastSerializationResult {
  return {
    peerCount: peers,
    payloadBytes,
    planDurationMs: 1,
    serializeDurationMs: 2,
    originalSerializeDurationMs: 0.5,
    transportMessages: peers,
    uniqueSerializedMessages: peers,
    totalSerializedBytes: peers * payloadBytes,
    originalSerializedBytes: payloadBytes,
    allTransportMessagesIdentical: false,
  };
}

it('RTC-B04 parses every multicast matrix worker and emits exact accepted samples', async () => {
  const smokeResult = Multicast.runRtcMulticastSerialization({ peers: 10, payloadBytes: 4096 });
  expect([
    smokeResult.peerCount,
    smokeResult.payloadBytes,
    smokeResult.transportMessages,
    smokeResult.uniqueSerializedMessages,
    smokeResult.allTransportMessagesIdentical,
  ]).toEqual([10, 4096, 10, 10, false]);
  expect(smokeResult.totalSerializedBytes).toBeGreaterThanOrEqual(
    smokeResult.originalSerializedBytes * smokeResult.transportMessages,
  );
  expect(smokeResult.planDurationMs).toBeGreaterThanOrEqual(0);
  expect(smokeResult.serializeDurationMs).toBeGreaterThanOrEqual(0);
  expect(smokeResult.originalSerializeDurationMs).toBeGreaterThanOrEqual(0);

  for (const peers of [10, 100, 1000] as const) {
    for (const payloadBytes of [4096, 65536] as const) {
      const input = worker(peers, payloadBytes);
      const parsed = Multicast.parseRtcMulticastSerializationArguments(input.arguments);
      if (!parsed.ok || parsed.value.mode !== 'accepted') {
        throw new Error('Expected exact B04 worker input.');
      }
      const samples = await Multicast.runRtcMulticastSerializationAcceptedSamples({
        worker: parsed.value,
        run: () => validAcceptedResult(peers, payloadBytes),
      });
      expect(samples.map((sample: RtcBaselineSampleDto) => sample.identity)).toEqual(
        input.ids.map((sampleId, index) => ({
          sampleId,
          workloadId: 'RTC-B04',
          caseId: 'multicast-serialization',
          inputKey: `peers-${peers}-payload-${payloadBytes}`,
          intendedPhase: 'retained',
          outerOrdinal: 1,
          innerOrdinal: index + 1,
        })),
      );
      expect(samples.map((sample: RtcBaselineSampleDto) => sample.outcome)).toEqual(
        Array(5).fill('passed'),
      );
      expect(samples[0]).toMatchObject({
        schema: 'rallar.rtc-baseline.sample.v1',
        evidenceClass: 'synthetic-path',
        rawReferences: [],
        runtimeObservation: null,
      });
      expect(samples[0]?.metrics).toHaveLength(3);
    }
  }
});

it('RTC-B04 rejects malformed multicast workers, persists causal failure remainder, and preserves overwrite diagnostics', async () => {
  const input = worker(10, 4096);
  expect(Multicast.parseRtcMulticastSerializationArguments(['--out=/tmp/result.json']).ok).toBe(
    true,
  );
  for (
    const [expected, replacement] of [
      ['--rtc-peers=10', '--rtc-peers=010'],
      ['--rtc-payload-bytes=4096', '--rtc-payload-bytes=04096'],
      ['--outer-ordinal=1', '--outer-ordinal=01'],
      ['--rtc-inner-runs=5', '--rtc-inner-runs=05'],
    ]
  ) {
    expect(
      Multicast.parseRtcMulticastSerializationArguments(
        input.arguments.map((argument) => (argument === expected ? replacement : argument)),
      ).ok,
    ).toBe(false);
  }
  let executions = 0;
  const acceptedWorker = Multicast.parseRtcMulticastSerializationArguments(input.arguments);
  if (!acceptedWorker.ok || acceptedWorker.value.mode !== 'accepted') {
    throw new Error('Expected exact B04 worker input.');
  }
  const samples = await Multicast.runRtcMulticastSerializationAcceptedSamples({
    worker: acceptedWorker.value,
    run: () => {
      executions += 1;
      return {
        ...validAcceptedResult(10, 4096),
        transportMessages: 9,
      };
    },
  });
  expect(executions).toBe(1);
  expect(samples.map((sample: RtcBaselineSampleDto) => [sample.identity.sampleId, sample.outcome]))
    .toEqual([
      [input.ids[0], 'failed'],
      ...input.ids.slice(1).map((sampleId) => [sampleId, 'not-run']),
    ]);
  expect(samples.slice(1).map((sample: RtcBaselineSampleDto) => sample.issues[0]?.code)).toEqual(
    Array(4).fill('causal-not-run'),
  );

  mkdirSync('tmp/perf/results', { recursive: true });
  const directory = mkdtempSync(join('tmp/perf/results', 'rtc-b04-multicast-diagnostic-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'result.json');
  const command = [
    'run',
    '--config=packages/shared-rtc-bench/deno.json',
    '--allow-read',
    '--allow-write',
    'packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts',
    '--peer-counts=10',
    '--payload-bytes=4096',
    '--runs=1',
    `--out=${output}`,
  ];
  expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8')).results).toHaveLength(1);
});
