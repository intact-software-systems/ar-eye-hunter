import { decodePlainRecord, getOwnNumber, hasExactKeys } from '../../../shared/api/exact-object-decoding.ts';
import { Either } from '../../../shared/resilience/Either.ts';

export interface DistributedRunEnvironment {
    readonly sourceCommit: string;
    readonly worktreeDirty: boolean;
    readonly apiMode: 'memory' | 'postgres';
    readonly databaseFreshness: 'fresh-ephemeral';
    readonly pubSub: string;
    readonly ice: string;
    readonly manifestSha256: string;
    readonly agentCount: number;
    readonly runtime: Readonly<{ node: string; bun: string; chromium: string; }>;
    readonly host: Readonly<{
        platform: string;
        release: string;
        cpuCount: number;
        availableParallelism: number;
        memoryBytes: number;
    }>;
    readonly loadAverage: Readonly<{ oneMinute: number; atStart: boolean; }>;
}

export interface DistributedRunHostReading {
    readonly platform: string;
    readonly release: string;
    readonly cpuCount: number;
    readonly availableParallelism: number;
    readonly memoryBytes: number;
    readonly oneMinuteLoadAverage: number;
}

export interface ReadDistributedRunEnvironmentInput {
    readonly apiMode: DistributedRunEnvironment['apiMode'];
    readonly pubSub: string;
    readonly ice: string;
    readonly manifestSha256: string;
    readonly agentCount: number;
    readonly nodeVersion: string;
    readonly chromiumExecutablePath: string;
    readonly readCommandOutput: (command: string, args: readonly string[]) => string;
    readonly readHost: () => DistributedRunHostReading;
}

/** Called once as the run starts, so the load reading is the load the run began under. */
export function readDistributedRunEnvironment(input: ReadDistributedRunEnvironmentInput): DistributedRunEnvironment {
    const host = input.readHost();
    return {
        sourceCommit: input.readCommandOutput('git', ['rev-parse', 'HEAD']).trim(),
        worktreeDirty: input.readCommandOutput('git', ['status', '--porcelain']).length > 0,
        apiMode: input.apiMode,
        databaseFreshness: 'fresh-ephemeral',
        pubSub: input.pubSub,
        ice: input.ice,
        manifestSha256: input.manifestSha256,
        agentCount: input.agentCount,
        runtime: {
            node: input.nodeVersion,
            bun: input.readCommandOutput('bun', ['--version']).trim(),
            chromium: input.readCommandOutput(input.chromiumExecutablePath, ['--version']).trim()
        },
        host: {
            platform: host.platform,
            release: host.release,
            cpuCount: host.cpuCount,
            availableParallelism: host.availableParallelism,
            memoryBytes: host.memoryBytes
        },
        loadAverage: { oneMinute: host.oneMinuteLoadAverage, atStart: true }
    };
}

const ENVIRONMENT_KEYS = [
    'sourceCommit',
    'worktreeDirty',
    'apiMode',
    'databaseFreshness',
    'pubSub',
    'ice',
    'manifestSha256',
    'agentCount',
    'runtime',
    'host',
    'loadAverage'
] as const;
const RUNTIME_KEYS = ['node', 'bun', 'chromium'] as const;
const HOST_KEYS = ['platform', 'release', 'cpuCount', 'availableParallelism', 'memoryBytes'] as const;
const LOAD_AVERAGE_KEYS = ['oneMinute', 'atStart'] as const;

function readOwnString(source: object, name: string): string | undefined {
    const value = Object.getOwnPropertyDescriptor(source, name)?.value;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOwnExactRecord(source: object, name: string, keys: readonly string[]): object | undefined {
    const nested = decodePlainRecord(Object.getOwnPropertyDescriptor(source, name)?.value).right;
    return nested !== undefined && hasExactKeys(nested, keys) ? nested : undefined;
}

function findStringIssues(source: object, path: string, names: readonly string[]): string[] {
    return names.flatMap((name) =>
        readOwnString(source, name) === undefined ? [`${path}${name} must be a non-empty string`] : []
    );
}

function findPositiveIntegerIssues(source: object, path: string, names: readonly string[]): string[] {
    return names.flatMap((name) => {
        const value = getOwnNumber(source, [name], Number.NaN);
        return Number.isSafeInteger(value) && value >= 1 ? [] : [`${path}${name} must be a whole number of at least 1`];
    });
}

function findRuntimeIssues(source: object): string[] {
    const runtime = readOwnExactRecord(source, 'runtime', RUNTIME_KEYS);
    return runtime === undefined
        ? [`runtime must hold exactly ${RUNTIME_KEYS.join(', ')}`]
        : findStringIssues(runtime, 'runtime.', RUNTIME_KEYS);
}

function findHostIssues(source: object): string[] {
    const host = readOwnExactRecord(source, 'host', HOST_KEYS);
    return host === undefined
        ? [`host must hold exactly ${HOST_KEYS.join(', ')}`]
        : [
            ...findStringIssues(host, 'host.', ['platform', 'release']),
            ...findPositiveIntegerIssues(host, 'host.', ['cpuCount', 'availableParallelism', 'memoryBytes'])
        ];
}

function findLoadAverageIssues(source: object): string[] {
    const loadAverage = readOwnExactRecord(source, 'loadAverage', LOAD_AVERAGE_KEYS);
    if (loadAverage === undefined) {
        return [`loadAverage must hold exactly ${LOAD_AVERAGE_KEYS.join(', ')}`];
    }
    const oneMinute = getOwnNumber(loadAverage, ['oneMinute'], Number.NaN);
    return [
        ...(Number.isFinite(oneMinute) && oneMinute >= 0
            ? []
            : ['loadAverage.oneMinute must be a finite number of at least 0']),
        ...(typeof Object.getOwnPropertyDescriptor(loadAverage, 'atStart')?.value === 'boolean'
            ? []
            : ['loadAverage.atStart must be a boolean'])
    ];
}

function findIssues(source: object): string[] {
    const issues = [
        ...findStringIssues(source, '', ['sourceCommit', 'pubSub', 'ice', 'manifestSha256']),
        ...findPositiveIntegerIssues(source, '', ['agentCount']),
        ...findRuntimeIssues(source),
        ...findHostIssues(source),
        ...findLoadAverageIssues(source)
    ];
    if (typeof Object.getOwnPropertyDescriptor(source, 'worktreeDirty')?.value !== 'boolean') {
        issues.push('worktreeDirty must be a boolean');
    }
    const apiMode = Object.getOwnPropertyDescriptor(source, 'apiMode')?.value;
    if (apiMode !== 'memory' && apiMode !== 'postgres') {
        issues.push('apiMode must be memory or postgres');
    }
    if (Object.getOwnPropertyDescriptor(source, 'databaseFreshness')?.value !== 'fresh-ephemeral') {
        issues.push('databaseFreshness must be fresh-ephemeral');
    }
    return issues;
}

export function decodeDistributedRunEnvironment(value: unknown): Either<readonly string[], DistributedRunEnvironment> {
    const source = decodePlainRecord(value).right;
    if (source === undefined) {
        return Either.ofLeft(['environment must be an exact object']);
    }
    const issues = hasExactKeys(source, ENVIRONMENT_KEYS)
        ? []
        : [`environment must hold exactly ${ENVIRONMENT_KEYS.join(', ')}`];
    issues.push(...findIssues(source));
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(source as DistributedRunEnvironment);
}

/** The flat facts two runs must share to be comparable; the commit and the load reading are reported, not matched. */
export function toDistributedRunRegimeKey(
    environment: DistributedRunEnvironment
): Readonly<Record<string, string | number | boolean>> {
    return {
        apiMode: environment.apiMode,
        databaseFreshness: environment.databaseFreshness,
        pubSub: environment.pubSub,
        ice: environment.ice,
        manifestSha256: environment.manifestSha256,
        agentCount: environment.agentCount,
        'runtime.node': environment.runtime.node,
        'runtime.bun': environment.runtime.bun,
        'runtime.chromium': environment.runtime.chromium,
        'host.platform': environment.host.platform,
        'host.release': environment.host.release,
        'host.cpuCount': environment.host.cpuCount,
        'host.availableParallelism': environment.host.availableParallelism,
        'host.memoryBytes': environment.host.memoryBytes
    };
}
