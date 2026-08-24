import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const diagnosticPath = 'packages/shared-rtc-bench/diagnostics/rtt-traffic/rtc-rtt-traffic-metrics.ts';

interface RtcRttTrafficArtifact {
    readonly createdAt: string;
    readonly input: {
        readonly sessionCount: number;
        readonly submittedRttCount: number;
    };
    readonly measurements: {
        readonly storedRttCount: number;
        readonly storedVersions: readonly number[];
    };
}

it('keeps the maintained RTT traffic diagnostic checked', { timeout: 30_000 }, () => {
    const result = spawnSync(
        'deno',
        ['check', '--config', 'packages/shared-rtc-bench/deno.json', diagnosticPath],
        { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
});

it('reports stored RTT mutations without claiming topology delivery', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'rallar-rtc-rtt-traffic-'));
    const outputPath = join(directory, 'metrics.json');
    try {
        const result = spawnSync(
            'deno',
            [
                'run',
                '--allow-write',
                '--config',
                'packages/shared-rtc-bench/deno.json',
                diagnosticPath,
                '--sessions=3',
                `--out=${outputPath}`
            ],
            { encoding: 'utf8' }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(decodeRtcRttTrafficArtifact(readFileSync(outputPath, 'utf8'))).toEqual({
            createdAt: expect.any(String),
            input: {
                sessionCount: 3,
                submittedRttCount: 3
            },
            measurements: {
                storedRttCount: 2,
                storedVersions: [1, 2]
            }
        });
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function decodeRtcRttTrafficArtifact(serialized: string): RtcRttTrafficArtifact {
    const artifact = JSON.parse(serialized);
    if (
        typeof artifact !== 'object' || artifact === null || Array.isArray(artifact) ||
        !hasExactKeys(artifact, ['createdAt', 'input', 'measurements'])
    ) {
        throw new TypeError('RTT traffic artifact must contain only current top-level fields');
    }
    const input = Reflect.get(artifact, 'input');
    const measurements = Reflect.get(artifact, 'measurements');
    const storedVersions = typeof measurements === 'object' && measurements !== null
        ? Reflect.get(measurements, 'storedVersions')
        : undefined;
    if (
        typeof Reflect.get(artifact, 'createdAt') !== 'string' ||
        typeof input !== 'object' || input === null || Array.isArray(input) ||
        !hasExactKeys(input, ['sessionCount', 'submittedRttCount']) ||
        typeof Reflect.get(input, 'sessionCount') !== 'number' ||
        typeof Reflect.get(input, 'submittedRttCount') !== 'number' ||
        typeof measurements !== 'object' || measurements === null || Array.isArray(measurements) ||
        !hasExactKeys(measurements, ['storedRttCount', 'storedVersions']) ||
        typeof Reflect.get(measurements, 'storedRttCount') !== 'number' ||
        !Array.isArray(storedVersions) ||
        !storedVersions.every((entry) => typeof entry === 'number')
    ) {
        throw new TypeError('RTT traffic artifact has an invalid current shape');
    }
    return {
        createdAt: Reflect.get(artifact, 'createdAt'),
        input: {
            sessionCount: Reflect.get(input, 'sessionCount'),
            submittedRttCount: Reflect.get(input, 'submittedRttCount')
        },
        measurements: {
            storedRttCount: Reflect.get(measurements, 'storedRttCount'),
            storedVersions
        }
    };
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(keys.toSorted());
}
