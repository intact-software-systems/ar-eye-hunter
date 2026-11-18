import { describe, expect, it } from 'vitest';
import {
    decodeDistributedRunEnvironment,
    readDistributedRunEnvironment,
    toDistributedRunRegimeKey,
    type DistributedRunEnvironment,
    type DistributedRunHostReading,
    type ReadDistributedRunEnvironmentInput
} from '../../../shared-test/rallar-bb-test/distributed-run-performance/distributed-run-environment.ts';
import { Either } from '../../../shared/resilience/Either.ts';

const HOST: DistributedRunHostReading = {
    platform: 'darwin',
    release: '27.2.0',
    cpuCount: 12,
    availableParallelism: 12,
    memoryBytes: 34_359_738_368,
    diskBytes: 994_662_584_320,
    diskAvailableBytes: 400_000_000_000,
    oneMinuteLoadAverage: 2.5
};

const TOPOLOGY = {
    topologyKind: 'auto',
    degreeLimit: 6,
    rttReportingDegreeLimit: 4,
    treeMinSize: 8,
    meshMinSize: 16,
    meshParamK: 3,
    meshExitWidth: 2,
    treeExitWidth: 2,
    rttReplanMinimumLayoutAgeMs: 7500
} as const;

interface FakeCommands {
    readonly commit?: Either<string, string>;
    readonly status?: Either<string, string>;
    readonly bun?: Either<string, string>;
    readonly chromium?: Either<string, string>;
}

function createReadCommandOutput(commands: FakeCommands): ReadDistributedRunEnvironmentInput['readCommandOutput'] {
    return (command, args) => {
        if (command === 'git') {
            return args[0] === 'rev-parse'
                ? commands.commit ?? Either.ofRight(`${'c'.repeat(40)}\n`)
                : commands.status ?? Either.ofRight(' M packages/shared/a.ts\n');
        }
        return command === 'bun'
            ? commands.bun ?? Either.ofRight('1.3.0\n')
            : commands.chromium ?? Either.ofRight('Chromium 140.0.1\n');
    };
}

function createReadInput(
    overrides: Partial<ReadDistributedRunEnvironmentInput> & { readonly commands?: FakeCommands; } = {}
): ReadDistributedRunEnvironmentInput {
    const { commands = {}, ...rest } = overrides;
    return {
        apiMode: 'postgres',
        profile: 'prod-in-memory',
        pubSub: 'postgres',
        ice: 'local',
        topology: TOPOLOGY,
        retention: { events: 'unbounded', results: 'unbounded' },
        rtcCaptureMode: 'native',
        manifestSha256: 'a'.repeat(64),
        agentCount: 15,
        nodeVersion: 'v24.1.0',
        chromiumExecutablePath: '/browsers/chromium',
        readCommandOutput: createReadCommandOutput(commands),
        readHost: () => HOST,
        ...rest
    };
}

function readEnvironment(overrides: Parameters<typeof createReadInput>[0] = {}): DistributedRunEnvironment {
    const read = readDistributedRunEnvironment(createReadInput(overrides));
    if (read.right === undefined) {
        throw new Error(`The fake readers failed: ${read.left?.join('; ')}`);
    }
    return read.right;
}

function toRecord(value: DistributedRunEnvironment): DistributedRunEnvironment {
    return JSON.parse(JSON.stringify(value));
}

function toHostFields(): Omit<DistributedRunHostReading, 'oneMinuteLoadAverage'> {
    const { oneMinuteLoadAverage: _load, ...host } = HOST;
    return host;
}

describe('distributed run environment', () => {
    it('names the commit, runtime, API mode, database freshness, carrier set, agent count, host and concurrent load of a run', () => {
        expect(readEnvironment()).toEqual({
            sourceCommit: 'c'.repeat(40),
            worktreeDirty: true,
            apiMode: 'postgres',
            databaseFreshness: 'fresh-ephemeral',
            profile: 'prod-in-memory',
            pubSub: 'postgres',
            ice: 'local',
            topology: TOPOLOGY,
            retention: { events: 'unbounded', results: 'unbounded' },
            rtcCaptureMode: 'native',
            manifestSha256: 'a'.repeat(64),
            agentCount: 15,
            runtime: { node: 'v24.1.0', bun: '1.3.0', chromium: 'Chromium 140.0.1' },
            host: {
                platform: 'darwin',
                release: '27.2.0',
                cpuCount: 12,
                availableParallelism: 12,
                memoryBytes: 34_359_738_368,
                diskBytes: 994_662_584_320,
                diskAvailableBytes: 400_000_000_000
            },
            loadAverage: { oneMinute: 2.5, atStart: true }
        });
    });

    it('returns the readings that failed, and throws nothing', () => {
        const refused = readDistributedRunEnvironment(createReadInput({
            commands: {
                commit: Either.ofLeft('exited with status 128'),
                bun: Either.ofRight('\n')
            }
        }));
        expect(refused.left).toEqual([
            'git rev-parse HEAD: exited with status 128',
            'bun --version: gave an empty value'
        ]);
        const missing = readDistributedRunEnvironment(createReadInput({
            commands: { status: Either.ofLeft('could not start'), chromium: Either.ofLeft('no output') }
        }));
        expect(missing.left).toEqual(['git status --porcelain: could not start', '/browsers/chromium --version: no output']);
    });

    it('decodes what it records', () => {
        const environment = readEnvironment();
        expect(decodeDistributedRunEnvironment(toRecord(environment)).right).toEqual(environment);
        expect(decodeDistributedRunEnvironment('nothing').left).toEqual(['environment must be an exact object']);
    });

    it('names a missing top-level field', () => {
        const { ice: _ice, ...withoutIce } = toRecord(readEnvironment());
        expect(decodeDistributedRunEnvironment(withoutIce).left).toEqual([
            `environment must hold exactly ${
                'sourceCommit, worktreeDirty, apiMode, databaseFreshness, profile, pubSub, ice, topology, retention, rtcCaptureMode, ' +
                'manifestSha256, agentCount, runtime, host, loadAverage'
            }`,
            'ice must be a non-empty string'
        ]);
    });

    it.each([
        ['runtime.bun', { runtime: { node: 'v24.1.0', bun: 1, chromium: 'Chromium 140.0.1' } }, ['runtime.bun must be a non-empty string']],
        ['host.cpuCount', { host: { ...toHostFields(), cpuCount: 0 } }, ['host.cpuCount must be a whole number of at least 1']],
        [
            'host.diskAvailableBytes',
            { host: { ...toHostFields(), diskAvailableBytes: 'lots' } },
            ['host.diskAvailableBytes must be a whole number of at least 0']
        ],
        ['loadAverage.atStart', { loadAverage: { oneMinute: 2.5, atStart: 'yes' } }, ['loadAverage.atStart must be true']],
        ['loadAverage.oneMinute', { loadAverage: { oneMinute: -1, atStart: true } }, [
            'loadAverage.oneMinute must be a finite number of at least 0'
        ]],
        ['databaseFreshness', { databaseFreshness: 'reused' }, ['databaseFreshness must be fresh-ephemeral']],
        ['worktreeDirty', { worktreeDirty: 'no' }, ['worktreeDirty must be a boolean']],
        ['apiMode', { apiMode: 'sqlite' }, ['apiMode must be memory or postgres']],
        ['manifestSha256', { manifestSha256: '' }, ['manifestSha256 must be a non-empty string']],
        ['pubSub', { pubSub: 7 }, ['pubSub must be a non-empty string']],
        ['profile', { profile: null }, ['profile must be a non-empty string']],
        ['agentCount', { agentCount: '15' }, ['agentCount must be a whole number of at least 1']],
        ['rtcCaptureMode', { rtcCaptureMode: undefined }, ['rtcCaptureMode must be a string']],
        ['topology field type', { topology: { ...TOPOLOGY, degreeLimit: '6' } }, ['topology.degreeLimit must be a whole number of at least 0']],
        [
            'topology kind',
            { topology: { ...TOPOLOGY, topologyKind: 'ring' } },
            ['topology.topologyKind must be one of auto, star, tree, mesh']
        ],
        ['retention field missing', { retention: { events: 'unbounded' } }, ['retention must hold exactly events, results']]
    ])('refuses a wrong %s with exactly that issue', (_name, change, expected) => {
        const refused = decodeDistributedRunEnvironment({ ...toRecord(readEnvironment()), ...change });
        expect(refused.left).toEqual(expected);
    });

    it('holds exactly the regime facts in its key', () => {
        expect(Object.keys(toDistributedRunRegimeKey(readEnvironment())).sort()).toEqual([
            'agentCount',
            'apiMode',
            'databaseFreshness',
            'host.availableParallelism',
            'host.cpuCount',
            'host.memoryBytes',
            'host.platform',
            'host.release',
            'ice',
            'manifestSha256',
            'profile',
            'pubSub',
            'retention.events',
            'retention.results',
            'rtcCaptureMode',
            'runtime.bun',
            'runtime.chromium',
            'runtime.node',
            'topology.degreeLimit',
            'topology.meshExitWidth',
            'topology.meshMinSize',
            'topology.meshParamK',
            'topology.rttReplanMinimumLayoutAgeMs',
            'topology.rttReportingDegreeLimit',
            'topology.topologyKind',
            'topology.treeExitWidth',
            'topology.treeMinSize'
        ]);
        expect(toDistributedRunRegimeKey(readEnvironment())).toMatchObject({
            profile: 'prod-in-memory',
            rtcCaptureMode: 'native',
            'topology.degreeLimit': 6,
            'retention.events': 'unbounded',
            'runtime.bun': '1.3.0',
            'host.cpuCount': 12
        });
    });

    it('keeps the commit, the dirty flag, the load reading and the disk readings out of the regime key', () => {
        const key = toDistributedRunRegimeKey(readEnvironment());
        const another = readEnvironment({
            commands: { commit: Either.ofRight('d'.repeat(40)), status: Either.ofRight('') },
            readHost: () => ({ ...HOST, oneMinuteLoadAverage: 9, diskAvailableBytes: 1, diskBytes: 2 })
        });
        expect(another.sourceCommit).not.toBe('c'.repeat(40));
        expect(another.worktreeDirty).toBe(false);
        expect(toDistributedRunRegimeKey(another)).toEqual(key);
    });

    it.each<[string, Parameters<typeof createReadInput>[0]]>([
        ['a topology field', { topology: { ...TOPOLOGY, degreeLimit: 8 } }],
        ['the profile', { profile: 'dev' }],
        ['the capture mode', { rtcCaptureMode: 'off' }],
        ['the retention', { retention: { events: 'unbounded', results: 'bounded' } }],
        ['the bun version', { commands: { bun: Either.ofRight('1.4.0') } }],
        ['the host', { readHost: () => ({ ...HOST, cpuCount: 8 }) }]
    ])('tells runs apart that differ in %s', (_name, change) => {
        expect(toDistributedRunRegimeKey(readEnvironment(change))).not.toEqual(toDistributedRunRegimeKey(readEnvironment()));
    });
});
