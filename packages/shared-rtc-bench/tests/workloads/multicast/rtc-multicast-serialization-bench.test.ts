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
      expect(samples[0]?.metrics).toEqual([
        { metric: 'planDurationMs', unit: 'ms', value: 1 },
        { metric: 'originalSerializeDurationMs', unit: 'ms', value: 0.5 },
        { metric: 'serializeDurationMs', unit: 'ms', value: 2 },
      ]);
      expect(samples[0]?.rawEvidence).toEqual(validAcceptedResult(peers, payloadBytes));
    }
  }
});

it('RTC-B04 rejects malformed multicast workers', () => {
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
  for (
    const replacement of [
      ['--workload=RTC-B04', '--workload=RTC-B03'],
      ['--case-id=multicast-serialization', '--case-id=wrong'],
      ['--input-key=peers-10-payload-4096', '--input-key=wrong'],
      ['--intended-phase=retained', '--intended-phase=wrong'],
      [`--sample-ids=${input.ids.join(',')}`, '--sample-ids=wrong'],
      ['--rtc-inner-runs=5', '--unexpected=1'],
    ]
  ) {
    expect(
      Multicast.parseRtcMulticastSerializationArguments(
        input.arguments.map((
          argument,
        ) => (argument === replacement[0] ? replacement[1] : argument)),
      ).ok,
    ).toBe(false);
  }
});

it('RTC-B04 records causal failure remainders', async () => {
  const input = worker(10, 4096);
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
  expect(samples.slice(1).map((sample) => sample.issues[0]?.message)).toEqual(
    Array(4).fill(input.ids[0]),
  );
});

it('RTC-B04 diagnostics create nested outputs and overwrite them', () => {
  mkdirSync('tmp', { recursive: true });
  const directory = mkdtempSync(join('tmp', 'rtc-b04-multicast-diagnostic-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'nested', 'result.json');
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

it('RTC-B04 fails every invalid result shape with JSON-safe evidence', async () => {
  const parsed = Multicast.parseRtcMulticastSerializationArguments(worker(10, 4096).arguments);
  if (!parsed.ok || parsed.value.mode !== 'accepted') throw new Error('Expected accepted worker.');
  const invalidResults = [
    { peerCount: 100 },
    { uniqueSerializedMessages: 1 },
    { allTransportMessagesIdentical: true },
    { originalSerializedBytes: Infinity, totalSerializedBytes: Infinity },
    { planDurationMs: -1 },
    { serializeDurationMs: Infinity },
  ];
  for (const invalidResult of invalidResults) {
    const samples = await Multicast.runRtcMulticastSerializationAcceptedSamples({
      worker: parsed.value,
      run: () => ({ ...validAcceptedResult(10, 4096), ...invalidResult }),
    });
    expect(samples[0]?.outcome).toBe('failed');
    expect(samples.slice(1).map((sample) => sample.outcome)).toEqual(Array(4).fill('not-run'));
    expect(samples.slice(1).map((sample) => sample.issues[0]?.code)).toEqual(
      Array(4).fill('causal-not-run'),
    );
    expect(samples.slice(1).map((sample) => sample.issues[0]?.message)).toEqual(
      Array(4).fill(samples[0]?.identity.sampleId),
    );
    expect(samples[0]?.rawEvidence).not.toBeNull();
    if ('serializeDurationMs' in invalidResult) {
      const restored = JSON.parse(JSON.stringify(samples[0]));
      expect(
        restored.metrics.every((metric: { value: unknown }) => typeof metric.value === 'number'),
      ).toBe(true);
      expect(restored.metrics.map((metric: { metric: string }) => metric.metric)).not.toContain(
        'serializeDurationMs',
      );
      expect((restored.rawEvidence as { serializeDurationMs: unknown }).serializeDurationMs)
        .toBeNull();
    }
  }
});
