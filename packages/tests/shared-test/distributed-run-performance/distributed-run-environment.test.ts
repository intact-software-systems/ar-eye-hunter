import { describe, expect, it } from 'vitest';
import {
    decodeDistributedRunEnvironment,
    readDistributedRunEnvironment,
    toDistributedRunRegimeKey,
    type DistributedRunEnvironment,
    type ReadDistributedRunEnvironmentInput
} from '../../../shared-test/rallar-bb-test/distributed-run-performance/distributed-run-environment.ts';

function createReadInput(overrides: Partial<ReadDistributedRunEnvironmentInput> = {}): ReadDistributedRunEnvironmentInput {
    return {
        apiMode: 'postgres',
        pubSub: 'postgres',
        ice: 'local',
        manifestSha256: 'a'.repeat(64),
        agentCount: 15,
        nodeVersion: 'v24.1.0',
        chromiumExecutablePath: '/browsers/chromium',
        readCommandOutput: (command, args) => {
            if (command === 'git' && args[0] === 'rev-parse') {
                return `${'c'.repeat(40)}\n`;
            }
            if (command === 'git' && args[0] === 'status') {
                return ' M packages/shared/a.ts\n';
            }
            if (command === 'bun') {
                return '1.3.0\n';
            }
            return 'Chromium 140.0.1\n';
        },
        readHost: () => ({
            platform: 'darwin',
            release: '27.2.0',
            cpuCount: 12,
            availableParallelism: 12,
            memoryBytes: 34_359_738_368,
            oneMinuteLoadAverage: 2.5
        }),
        ...overrides
    };
}

function readEnvironment(): DistributedRunEnvironment {
    return readDistributedRunEnvironment(createReadInput());
}

describe('distributed run environment', () => {
    it('names the commit, runtime, API mode, database freshness, carrier set, agent count, host and concurrent load of a run', () => {
        expect(readEnvironment()).toEqual({
            sourceCommit: 'c'.repeat(40),
            worktreeDirty: true,
            apiMode: 'postgres',
            databaseFreshness: 'fresh-ephemeral',
            pubSub: 'postgres',
            ice: 'local',
            manifestSha256: 'a'.repeat(64),
            agentCount: 15,
            runtime: { node: 'v24.1.0', bun: '1.3.0', chromium: 'Chromium 140.0.1' },
            host: { platform: 'darwin', release: '27.2.0', cpuCount: 12, availableParallelism: 12, memoryBytes: 34_359_738_368 },
            loadAverage: { oneMinute: 2.5, atStart: true }
        });
    });

    it('decodes what it records, and names every missing or mistyped field', () => {
        const environment = readEnvironment();
        expect(decodeDistributedRunEnvironment(JSON.parse(JSON.stringify(environment))).right).toEqual(environment);

        const refused = decodeDistributedRunEnvironment({
            ...environment,
            sourceCommit: 7,
            apiMode: 'sqlite',
            agentCount: '15',
            runtime: { node: 'v24.1.0', bun: 1, extra: true },
            host: { platform: 'darwin' },
            loadAverage: { oneMinute: 'high', atStart: true },
            ice: undefined
        });
        expect(refused.left).toEqual(expect.arrayContaining([
            'sourceCommit must be a non-empty string',
            'apiMode must be memory or postgres',
            'agentCount must be a whole number of at least 1',
            'ice must be a non-empty string',
            'runtime must hold exactly node, bun, chromium',
            'host must hold exactly platform, release, cpuCount, availableParallelism, memoryBytes',
            'loadAverage.oneMinute must be a finite number of at least 0'
        ]));
        expect(decodeDistributedRunEnvironment('nothing').left).toEqual(['environment must be an exact object']);
    });

    it('keeps the commit and the load reading out of the regime key', () => {
        const environment = readEnvironment();
        const key = toDistributedRunRegimeKey(environment);
        expect(Object.keys(key).join(' ')).not.toMatch(/sourceCommit|worktreeDirty|load/);
        const another = readDistributedRunEnvironment(createReadInput({
            readCommandOutput: (command) => command === 'git' ? 'd'.repeat(40) : '1.3.0',
            readHost: () => ({ ...createReadInput().readHost(), oneMinuteLoadAverage: 9 })
        }));
        expect(another.sourceCommit).not.toBe(environment.sourceCommit);
        expect(toDistributedRunRegimeKey({ ...another, runtime: environment.runtime })).toEqual(key);
        expect(toDistributedRunRegimeKey({ ...environment, agentCount: 50 })).not.toEqual(key);
    });
});
