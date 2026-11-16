import { decodePlainRecord, hasExactKeys } from '../../../shared/api/exact-object-decoding.ts';
import { getOwnCount, getOwnField } from '../../../shared/api/topology-plan/get-own-field.ts';
import { Either } from '../../../shared/resilience/Either.ts';

/** Every field of the API's topology planning configuration: they decide the planned layout and the re-plan cadence. */
export interface DistributedRunTopologyEnvironment {
    readonly topologyKind: 'auto' | 'star' | 'tree' | 'mesh';
    readonly degreeLimit: number;
    readonly rttReportingDegreeLimit: number;
    readonly treeMinSize: number;
    readonly meshMinSize: number;
    readonly meshParamK: number;
    readonly meshExitWidth: number;
    readonly treeExitWidth: number;
    readonly rttReplanMinimumLayoutAgeMs: number;
}

export interface DistributedRunEnvironment {
    readonly sourceCommit: string;
    readonly worktreeDirty: boolean;
    readonly apiMode: 'memory' | 'postgres';
    readonly databaseFreshness: 'fresh-ephemeral';
    readonly profile: string;
    readonly pubSub: string;
    readonly ice: string;
    readonly topology: DistributedRunTopologyEnvironment;
    readonly retention: Readonly<{ events: string; results: string; }>;
    readonly rtcCaptureMode: string;
    readonly manifestSha256: string;
    readonly agentCount: number;
    readonly runtime: Readonly<{ node: string; bun: string; chromium: string; }>;
    readonly host: Readonly<{
        platform: string;
        release: string;
        cpuCount: number;
        availableParallelism: number;
        memoryBytes: number;
        diskBytes: number;
        diskAvailableBytes: number;
    }>;
    readonly loadAverage: Readonly<{ oneMinute: number; atStart: true; }>;
}

export interface DistributedRunHostReading {
    readonly platform: string;
    readonly release: string;
    readonly cpuCount: number;
    readonly availableParallelism: number;
    readonly memoryBytes: number;
    readonly diskBytes: number;
    readonly diskAvailableBytes: number;
    readonly oneMinuteLoadAverage: number;
}

export interface ReadDistributedRunEnvironmentInput {
    readonly apiMode: DistributedRunEnvironment['apiMode'];
    readonly profile: string;
    readonly pubSub: string;
    readonly ice: string;
    readonly topology: DistributedRunTopologyEnvironment;
    readonly retention: DistributedRunEnvironment['retention'];
    readonly rtcCaptureMode: string;
    readonly manifestSha256: string;
    readonly agentCount: number;
    readonly nodeVersion: string;
    readonly chromiumExecutablePath: string;
    /** Left names why the command gave no output: it could not start, or it exited non-zero. */
    readonly readCommandOutput: (command: string, args: readonly string[]) => Either<string, string>;
    readonly readHost: () => DistributedRunHostReading;
}

function readCommandValue(
    input: ReadDistributedRunEnvironmentInput,
    command: string,
    args: readonly string[]
): Either<string, string> {
    const label = `${command} ${args.join(' ')}`;
    return input.readCommandOutput(command, args).fold(
        (reason) => Either.ofLeft(`${label}: ${reason}`),
        (output) =>
            output.trim().length > 0 ? Either.ofRight(output.trim()) : Either.ofLeft(`${label}: gave an empty value`)
    );
}

/** Called once as the run starts, so the load reading is the load the run began under. */
export function readDistributedRunEnvironment(
    input: ReadDistributedRunEnvironmentInput
): Either<readonly string[], DistributedRunEnvironment> {
    const commit = readCommandValue(input, 'git', ['rev-parse', 'HEAD']);
    const status = input.readCommandOutput('git', ['status', '--porcelain']);
    const bun = readCommandValue(input, 'bun', ['--version']);
    const chromium = readCommandValue(input, input.chromiumExecutablePath, ['--version']);
    const issues = [
        commit.left,
        status.left === undefined ? undefined : `git status --porcelain: ${status.left}`,
        bun.left,
        chromium.left
    ].filter((issue) => issue !== undefined);
    if (
        issues.length > 0 || commit.right === undefined || status.right === undefined || bun.right === undefined ||
        chromium.right === undefined
    ) {
        return Either.ofLeft(issues);
    }
    const host = input.readHost();
    return Either.ofRight({
        sourceCommit: commit.right,
        worktreeDirty: status.right.length > 0,
        apiMode: input.apiMode,
        databaseFreshness: 'fresh-ephemeral',
        profile: input.profile,
        pubSub: input.pubSub,
        ice: input.ice,
        topology: input.topology,
        retention: input.retention,
        rtcCaptureMode: input.rtcCaptureMode,
        manifestSha256: input.manifestSha256,
        agentCount: input.agentCount,
        runtime: { node: input.nodeVersion, bun: bun.right, chromium: chromium.right },
        host: {
            platform: host.platform,
            release: host.release,
            cpuCount: host.cpuCount,
            availableParallelism: host.availableParallelism,
            memoryBytes: host.memoryBytes,
            diskBytes: host.diskBytes,
            diskAvailableBytes: host.diskAvailableBytes
        },
        loadAverage: { oneMinute: host.oneMinuteLoadAverage, atStart: true }
    });
}

const ENVIRONMENT_KEYS = [
    'sourceCommit',
    'worktreeDirty',
    'apiMode',
    'databaseFreshness',
    'profile',
    'pubSub',
    'ice',
    'topology',
    'retention',
    'rtcCaptureMode',
    'manifestSha256',
    'agentCount',
    'runtime',
    'host',
    'loadAverage'
] as const;
const TOPOLOGY_COUNT_KEYS = [
    'degreeLimit',
    'rttReportingDegreeLimit',
    'treeMinSize',
    'meshMinSize',
    'meshParamK',
    'meshExitWidth',
    'treeExitWidth',
    'rttReplanMinimumLayoutAgeMs'
] as const;
const TOPOLOGY_KEYS = ['topologyKind', ...TOPOLOGY_COUNT_KEYS] as const;
const RETENTION_KEYS = ['events', 'results'] as const;
const RUNTIME_KEYS = ['node', 'bun', 'chromium'] as const;
const HOST_TEXT_KEYS = ['platform', 'release'] as const;
const HOST_POSITIVE_KEYS = ['cpuCount', 'availableParallelism', 'memoryBytes', 'diskBytes'] as const;
const HOST_COUNT_KEYS = ['diskAvailableBytes'] as const;
const HOST_KEYS = [...HOST_TEXT_KEYS, ...HOST_POSITIVE_KEYS, ...HOST_COUNT_KEYS] as const;
const LOAD_AVERAGE_KEYS = ['oneMinute', 'atStart'] as const;
const TOPOLOGY_KINDS = ['auto', 'star', 'tree', 'mesh'];

function findTextIssues(source: object, path: string, names: readonly string[]): string[] {
    return names.flatMap((name) => {
        const value = getOwnField(source, name);
        return typeof value === 'string' && value.length > 0 ? [] : [`${path}${name} must be a non-empty string`];
    });
}

function findCountIssues(source: object, path: string, names: readonly string[]): string[] {
    return names.flatMap((name) =>
        getOwnCount(source, name) === null ? [`${path}${name} must be a whole number of at least 0`] : []
    );
}

function findPositiveCountIssues(source: object, path: string, names: readonly string[]): string[] {
    return names.flatMap((name) => {
        const count = getOwnCount(source, name);
        return count !== null && count >= 1 ? [] : [`${path}${name} must be a whole number of at least 1`];
    });
}

function decodeNestedRecord(value: unknown, path: string, keys: readonly string[]): Either<readonly string[], object> {
    const record = decodePlainRecord(value).right;
    return record !== undefined && hasExactKeys(record, keys)
        ? Either.ofRight(record)
        : Either.ofLeft([`${path} must hold exactly ${keys.join(', ')}`]);
}

function decodeTopology(value: unknown): readonly string[] {
    return decodeNestedRecord(value, 'topology', TOPOLOGY_KEYS).fold(
        (issues) => issues,
        (topology) => [
            ...(TOPOLOGY_KINDS.includes(getOwnField(topology, 'topologyKind'))
                ? []
                : [`topology.topologyKind must be one of ${TOPOLOGY_KINDS.join(', ')}`]),
            ...findCountIssues(topology, 'topology.', TOPOLOGY_COUNT_KEYS)
        ]
    );
}

function decodeRetention(value: unknown): readonly string[] {
    return decodeNestedRecord(value, 'retention', RETENTION_KEYS).fold(
        (issues) => issues,
        (retention) => findTextIssues(retention, 'retention.', RETENTION_KEYS)
    );
}

function decodeRuntime(value: unknown): readonly string[] {
    return decodeNestedRecord(value, 'runtime', RUNTIME_KEYS).fold(
        (issues) => issues,
        (runtime) => findTextIssues(runtime, 'runtime.', RUNTIME_KEYS)
    );
}

function decodeHost(value: unknown): readonly string[] {
    return decodeNestedRecord(value, 'host', HOST_KEYS).fold(
        (issues) => issues,
        (host) => [
            ...findTextIssues(host, 'host.', HOST_TEXT_KEYS),
            ...findPositiveCountIssues(host, 'host.', HOST_POSITIVE_KEYS),
            ...findCountIssues(host, 'host.', HOST_COUNT_KEYS)
        ]
    );
}

function decodeLoadAverage(value: unknown): readonly string[] {
    return decodeNestedRecord(value, 'loadAverage', LOAD_AVERAGE_KEYS).fold(
        (issues) => issues,
        (loadAverage) => {
            const oneMinute = getOwnField(loadAverage, 'oneMinute');
            return [
                ...(typeof oneMinute === 'number' && Number.isFinite(oneMinute) && oneMinute >= 0
                    ? []
                    : ['loadAverage.oneMinute must be a finite number of at least 0']),
                ...(getOwnField(loadAverage, 'atStart') === true ? [] : ['loadAverage.atStart must be true'])
            ];
        }
    );
}

function findScalarIssues(source: object): string[] {
    return [
        ...findTextIssues(source, '', ['sourceCommit', 'profile', 'pubSub', 'ice', 'manifestSha256']),
        ...findPositiveCountIssues(source, '', ['agentCount']),
        ...(typeof getOwnField(source, 'worktreeDirty') === 'boolean' ? [] : ['worktreeDirty must be a boolean']),
        ...(['memory', 'postgres'].includes(getOwnField(source, 'apiMode'))
            ? []
            : ['apiMode must be memory or postgres']),
        ...(getOwnField(source, 'databaseFreshness') === 'fresh-ephemeral'
            ? []
            : ['databaseFreshness must be fresh-ephemeral']),
        ...(typeof getOwnField(source, 'rtcCaptureMode') === 'string' ? [] : ['rtcCaptureMode must be a string'])
    ];
}

export function decodeDistributedRunEnvironment(value: unknown): Either<readonly string[], DistributedRunEnvironment> {
    const source = decodePlainRecord(value).right;
    if (source === undefined) {
        return Either.ofLeft(['environment must be an exact object']);
    }
    const issues = [
        ...(hasExactKeys(source, ENVIRONMENT_KEYS)
            ? []
            : [`environment must hold exactly ${ENVIRONMENT_KEYS.join(', ')}`]),
        ...findScalarIssues(source),
        ...decodeTopology(getOwnField(source, 'topology')),
        ...decodeRetention(getOwnField(source, 'retention')),
        ...decodeRuntime(getOwnField(source, 'runtime')),
        ...decodeHost(getOwnField(source, 'host')),
        ...decodeLoadAverage(getOwnField(source, 'loadAverage'))
    ];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(source as DistributedRunEnvironment);
}

/**
 * The flat facts two runs must share to be comparable. The commit, the dirty flag, the load reading and the disk readings
 * are reported, not matched.
 */
export function toDistributedRunRegimeKey(
    environment: DistributedRunEnvironment
): Readonly<Record<string, string | number | boolean>> {
    const { topology, retention, runtime, host } = environment;
    return {
        apiMode: environment.apiMode,
        databaseFreshness: environment.databaseFreshness,
        profile: environment.profile,
        pubSub: environment.pubSub,
        ice: environment.ice,
        rtcCaptureMode: environment.rtcCaptureMode,
        manifestSha256: environment.manifestSha256,
        agentCount: environment.agentCount,
        ...Object.fromEntries(Object.entries(topology).map(([name, value]) => [`topology.${name}`, value])),
        'retention.events': retention.events,
        'retention.results': retention.results,
        'runtime.node': runtime.node,
        'runtime.bun': runtime.bun,
        'runtime.chromium': runtime.chromium,
        'host.platform': host.platform,
        'host.release': host.release,
        'host.cpuCount': host.cpuCount,
        'host.availableParallelism': host.availableParallelism,
        'host.memoryBytes': host.memoryBytes
    };
}
