import { spawnSync } from 'node:child_process';

interface ScenarioMeasurement {
  readonly sampleCount: number;
  readonly sourcePayloadBytes: number;
  readonly finalization: { readonly peak: { readonly heapUsed: number; readonly rss: number } };
  readonly validation: { readonly peak: { readonly heapUsed: number; readonly rss: number } };
}

const scenarioPath =
  'packages/shared-rtc-bench/tests/baseline/evidence/rtc-baseline-memory-bounds-scenario.ts';

it('finalizes and validates a corpus larger than the constrained heap without retaining it', () => {
  const result = spawnSync(
    'deno',
    [
      'run',
      '--no-check',
      '--config=packages/shared-rtc-bench/deno.json',
      '--v8-flags=--max-old-space-size=64,--expose-gc',
      scenarioPath,
      '--samples=640',
      '--payload-bytes=131072',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );

  expect(result.status, result.stderr).toBe(0);
  const measurement = JSON.parse(result.stdout) as ScenarioMeasurement;
  expect(measurement).toMatchObject({
    sampleCount: 640,
    sourcePayloadBytes: 83_886_080,
    finalization: { peak: { heapUsed: expect.any(Number), rss: expect.any(Number) } },
    validation: { peak: { heapUsed: expect.any(Number), rss: expect.any(Number) } },
  });
}, 120_000);
