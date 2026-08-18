import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../../../..');
const baselineId = `20260818-${process.pid.toString(16).padStart(12, '0')}-e2-browser`;
const baselineRoot = path.join(repoRoot, 'tmp/perf/rtc-baseline', baselineId);

afterEach(() => rmSync(baselineRoot, { recursive: true, force: true }));

describe('RTC baseline CLI process output', () => {
  it('flushes every external attempt before process exit', () => {
    mkdirSync(baselineRoot, { recursive: true });
    writeFileSync(
      path.join(baselineRoot, 'manifest.json'),
      JSON.stringify({
        schema: 'rallar.rtc-baseline.manifest.v1',
        request: {
          schema: 'rallar.rtc-baseline.capture-request.v1',
          baselineId,
          workloadIds: ['RTC-B05'],
          environmentId: 'E2-browser',
          retainedSampleMultiplier: 1,
          repeatLink: null,
          conditionalEnvironmentDecisions: [],
        },
        workloadIds: ['RTC-B05'],
        cases: [
          {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
          },
        ],
        outerAttempts: [
          {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            environmentId: 'E2-browser',
            intendedPhase: 'warmup',
            outerOrdinal: 1,
            sampleIds: ['warmup-sample'],
          },
          {
            workloadId: 'RTC-B05',
            caseId: 'browser-data-channel-lifecycle',
            inputKey: 'iterations-25',
            environmentId: 'E2-browser',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            sampleIds: ['retained-sample'],
          },
        ],
        expectedCohorts: [],
        repeatLink: null,
      }),
    );

    const output = execFileSync(
      'deno',
      [
        'run',
        '-A',
        '--config',
        'packages/shared-rtc-bench/deno.json',
        'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts',
        'list-external-attempts',
        `--baseline-id=${baselineId}`,
        '--workload=RTC-B05',
        '--format=tsv',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toBe(
      'browser-data-channel-lifecycle\twarmup\t1\tE2-browser\n' +
        'browser-data-channel-lifecycle\tretained\t1\tE2-browser\n',
    );
  });
});
