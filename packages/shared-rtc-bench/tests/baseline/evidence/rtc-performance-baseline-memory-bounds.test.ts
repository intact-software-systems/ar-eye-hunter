import { spawnSync } from 'node:child_process';

interface ScenarioMeasurement {
    readonly sampleCount: number;
    readonly sourcePayloadBytes: number;
    readonly finalization: { readonly peak: { readonly heapUsed: number; readonly rss: number; }; };
    readonly validation: { readonly peak: { readonly heapUsed: number; readonly rss: number; }; };
}

const scenarioPath = 'packages/shared-rtc-bench/tests/baseline/evidence/rtc-baseline-memory-bounds-scenario.ts';

it('finalizes and validates the generated corpus without retaining it in memory', () => {
    const result = spawnSync(
        'bun',
        [
            'run',
            scenarioPath,
            '--samples=640',
            '--payload-bytes=131072'
        ],
        { encoding: 'utf8', timeout: 120_000 }
    );

    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout) as ScenarioMeasurement;
    expect(measurement.sampleCount).toBe(640);
    expect(measurement.sourcePayloadBytes).toBe(83_886_080);
    // Bun 1.4.4 has no reliable hard heap cap: --max-old-space-size is silently
    // ignored and BUN_JSC_forceRAMSize does not bound JSC allocation. Assert the
    // streaming property directly instead: peak heap stays below the corpus, so a
    // regression to buffering the whole corpus is still caught.
    expect(measurement.finalization.peak.heapUsed).toBeLessThan(measurement.sourcePayloadBytes);
    expect(measurement.validation.peak.heapUsed).toBeLessThan(measurement.sourcePayloadBytes);
}, 120_000);
