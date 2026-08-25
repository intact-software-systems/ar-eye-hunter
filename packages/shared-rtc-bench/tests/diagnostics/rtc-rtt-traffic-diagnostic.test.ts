import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

const diagnosticPath = 'packages/shared-rtc-bench/diagnostics/rtc-rtt-traffic-metrics.ts';

interface RtcRttTrafficArtifact {
    readonly createdAt: string;
    readonly input: {
        readonly sessionCount: number;
        readonly submittedRttCount: number;
    };
    readonly measurements: {
        readonly durableEnqueueCount: number;
        readonly enqueuedVersions: readonly number[];
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

it('reports durable RTT enqueue traffic without claiming mutation completion', { timeout: 30_000 }, () => {
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
                durableEnqueueCount: 3,
                enqueuedVersions: [1, 2, 3]
            }
        });
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function decodeRtcRttTrafficArtifact(serialized: string): RtcRttTrafficArtifact {
    const artifact = requireJsonObject(
        decodeJsonWireValue(JSON.parse(serialized), 'RTT traffic artifact'),
        'RTT traffic artifact'
    );
    const input = requireJsonObject(artifact.input, 'RTT traffic artifact input');
    const measurements = requireJsonObject(
        artifact.measurements,
        'RTT traffic artifact measurements'
    );
    const enqueuedVersions = measurements.enqueuedVersions;
    if (
        !hasExactKeys(artifact, ['createdAt', 'input', 'measurements']) ||
        typeof artifact.createdAt !== 'string' ||
        !hasExactKeys(input, ['sessionCount', 'submittedRttCount']) ||
        typeof input.sessionCount !== 'number' ||
        typeof input.submittedRttCount !== 'number' ||
        !hasExactKeys(measurements, ['durableEnqueueCount', 'enqueuedVersions']) ||
        typeof measurements.durableEnqueueCount !== 'number' ||
        !isNumberArray(enqueuedVersions)
    ) {
        throw new TypeError('RTT traffic artifact has an invalid current shape');
    }
    return {
        createdAt: artifact.createdAt,
        input: {
            sessionCount: input.sessionCount,
            submittedRttCount: input.submittedRttCount
        },
        measurements: {
            durableEnqueueCount: measurements.durableEnqueueCount,
            enqueuedVersions
        }
    };
}

function requireJsonObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!isJsonObject(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isJsonObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumberArray(value: JsonWireValue): value is readonly number[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function hasExactKeys(value: JsonWireObject, keys: readonly string[]): boolean {
    return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(keys.toSorted());
}
