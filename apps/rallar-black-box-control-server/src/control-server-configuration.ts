import { RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';

export interface BlackBoxControlEnvironment {
    get(key: string): string | undefined;
}

export interface BlackBoxControlServerConfiguration {
    readonly allowedOrigins: readonly string[];
    readonly requireTls: boolean;
    readonly requireRunToken: boolean;
    readonly requireReadToken: boolean;
    /** Absent when no shared admin token is configured; with no operator secret either, admin routes are open. */
    readonly adminToken?: string;
    /** Absent when operator tokens are not accepted. */
    readonly operatorTokenSecret?: string;
    readonly runTokenTtlMs: number;
    readonly maxRequestBytes: number;
    /** Absent when every command kind is allowed. */
    readonly allowedCommandKinds?: readonly string[];
    readonly commandRateLimitMax: number;
    readonly commandRateLimitWindowMs: number;
    readonly httpAllowedHosts: readonly string[];
    readonly httpAllowedOrigins: readonly string[];
    readonly wsAllowedHosts: readonly string[];
    readonly wsAllowedOrigins: readonly string[];
    /** Absent when the server keeps no snapshot or artifact files. */
    readonly storageDir?: string;
    readonly retentionMaxRuns: number;
    /** The least time between two snapshot writes. */
    readonly snapshotFlushIntervalMs: number;
    /** The cadence on which reload deadlines, cleanup refusals, barrier timeouts and rollups are judged. */
    readonly deadlineSweepIntervalMs: number;
    readonly snapshotPersistenceBounds: ControlRunSnapshotBounds;
    readonly runtimeRetentionBounds: ControlRunSnapshotBounds;
}

type SnapshotBoundsPrefix = 'SNAPSHOT_PERSIST' | 'RUNTIME_RETAIN';

const DEFAULT_SNAPSHOT_PERSISTENCE_BOUNDS: Required<ControlRunSnapshotBounds> = {
    commands: 500,
    results: 500,
    events: 1_000,
    stats: 200,
    reports: 100,
    heartbeats: 100
};
const DEFAULT_RUNTIME_RETENTION_BOUNDS: Required<ControlRunSnapshotBounds> = {
    commands: 1_000,
    results: 1_000,
    // The ALM observation's ALM_OBSERVATION_CONTROL_SERVER_RETAINED_EVENTS reads a run at this bound as trimmed.
    events: 2_000,
    stats: 500,
    reports: 20,
    heartbeats: 500
};
/** A 50-agent snapshot serializes to about 33 MB in 100–300 ms; one write per two seconds keeps that under a tenth of the loop. */
const DEFAULT_SNAPSHOT_FLUSH_INTERVAL_MS = 2_000;
/** Well inside the agents' 10 s barrier-resolution grace, so a timed-out barrier is judged before an agent gives up. */
const DEFAULT_DEADLINE_SWEEP_INTERVAL_MS = 1_000;
const UNBOUNDED_SNAPSHOT_LIMITS = new Set(['all', 'unbounded', 'none']);
const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'on']);

export function readBlackBoxControlServerConfiguration(
    environment: BlackBoxControlEnvironment
): BlackBoxControlServerConfiguration {
    const allowedCommandKinds = readEnvironmentList(environment, 'RALLAR_BLACK_BOX_ALLOWED_COMMANDS');
    return {
        ...readAccessConfiguration(environment),
        maxRequestBytes: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_MAX_REQUEST_BYTES',
            RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES
        ),
        allowedCommandKinds: allowedCommandKinds.length > 0 ? allowedCommandKinds : undefined,
        commandRateLimitMax: readEnvironmentNumber(environment, 'RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX', 120),
        commandRateLimitWindowMs: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS',
            60_000
        ),
        httpAllowedHosts: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS'),
        httpAllowedOrigins: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS'),
        wsAllowedHosts: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS'),
        wsAllowedOrigins: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS'),
        storageDir: readEnvironmentString(environment, 'RALLAR_BLACK_BOX_STORAGE_DIR'),
        retentionMaxRuns: readEnvironmentNumber(environment, 'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS', 0),
        snapshotFlushIntervalMs: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS',
            DEFAULT_SNAPSHOT_FLUSH_INTERVAL_MS
        ),
        deadlineSweepIntervalMs: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_DEADLINE_SWEEP_INTERVAL_MS',
            DEFAULT_DEADLINE_SWEEP_INTERVAL_MS
        ),
        snapshotPersistenceBounds: readSnapshotBounds(
            environment,
            'SNAPSHOT_PERSIST',
            DEFAULT_SNAPSHOT_PERSISTENCE_BOUNDS
        ),
        runtimeRetentionBounds: readSnapshotBounds(environment, 'RUNTIME_RETAIN', DEFAULT_RUNTIME_RETENTION_BOUNDS)
    };
}

export function validateBlackBoxControlServerConfiguration(
    configuration: BlackBoxControlServerConfiguration
): readonly string[] {
    return configuration.maxRequestBytes < RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES
        ? [
            `RALLAR_BLACK_BOX_MAX_REQUEST_BYTES must be at least ${RALLAR_BLACK_BOX_CONTROL_MAX_FRAME_BYTES}, the frame limit agents send to; got ${configuration.maxRequestBytes}.`
        ]
        : [];
}

function readAccessConfiguration(
    environment: BlackBoxControlEnvironment
): Pick<
    BlackBoxControlServerConfiguration,
    | 'adminToken'
    | 'allowedOrigins'
    | 'operatorTokenSecret'
    | 'requireReadToken'
    | 'requireRunToken'
    | 'requireTls'
    | 'runTokenTtlMs'
> {
    return {
        allowedOrigins: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS'),
        requireTls: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_TLS'),
        requireRunToken: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN'),
        requireReadToken: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN'),
        adminToken: readEnvironmentString(environment, 'RALLAR_BLACK_BOX_ADMIN_TOKEN'),
        operatorTokenSecret: readEnvironmentString(environment, 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET'),
        runTokenTtlMs: readEnvironmentNumber(environment, 'RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS', 15 * 60_000)
    };
}

function readSnapshotBounds(
    environment: BlackBoxControlEnvironment,
    prefix: SnapshotBoundsPrefix,
    defaults: Required<ControlRunSnapshotBounds>
): ControlRunSnapshotBounds {
    return {
        commands: readEnvironmentSnapshotLimit(environment, `RALLAR_BLACK_BOX_${prefix}_COMMANDS`, defaults.commands),
        results: readEnvironmentSnapshotLimit(environment, `RALLAR_BLACK_BOX_${prefix}_RESULTS`, defaults.results),
        events: readEnvironmentSnapshotLimit(environment, `RALLAR_BLACK_BOX_${prefix}_EVENTS`, defaults.events),
        stats: readEnvironmentSnapshotLimit(environment, `RALLAR_BLACK_BOX_${prefix}_STATS`, defaults.stats),
        reports: readEnvironmentSnapshotLimit(environment, `RALLAR_BLACK_BOX_${prefix}_REPORTS`, defaults.reports),
        heartbeats: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_HEARTBEATS`,
            defaults.heartbeats
        )
    };
}

function readEnvironmentString(environment: BlackBoxControlEnvironment, key: string): string | undefined {
    const value = environment.get(key)?.trim();
    return value ? value : undefined;
}

function readEnvironmentList(environment: BlackBoxControlEnvironment, key: string): string[] {
    return (environment.get(key) ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function readEnvironmentNumber(environment: BlackBoxControlEnvironment, key: string, fallback: number): number {
    const parsed = Number.parseInt(environment.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readEnvironmentBoolean(environment: BlackBoxControlEnvironment, key: string): boolean {
    return TRUE_FLAGS.has((environment.get(key) ?? '').trim().toLowerCase());
}

function readEnvironmentSnapshotLimit(
    environment: BlackBoxControlEnvironment,
    key: string,
    fallback: number
): number | undefined {
    const normalized = (environment.get(key) ?? '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    if (UNBOUNDED_SNAPSHOT_LIMITS.has(normalized)) {
        return undefined;
    }
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
