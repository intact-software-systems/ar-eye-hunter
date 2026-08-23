import type { RallarBlackBoxTestCommandKind } from '@shared-test/rallar-bb-test/types.ts';

import type { ControlRunSnapshotBounds } from './control-service.ts';

export interface BlackBoxControlEnvironment {
    get(key: string): string | undefined;
}

export interface BlackBoxControlServerConfiguration {
    readonly allowedOrigins: readonly string[];
    readonly requireTls: boolean;
    readonly requireRunToken: boolean;
    readonly requireReadToken: boolean;
    readonly adminToken?: string;
    readonly operatorTokenSecret?: string;
    readonly runTokenTtlMs: number;
    readonly maxRequestBytes: number;
    readonly allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    readonly commandRateLimitMax: number;
    readonly commandRateLimitWindowMs: number;
    readonly httpAllowedHosts: readonly string[];
    readonly httpAllowedOrigins: readonly string[];
    readonly wsAllowedHosts: readonly string[];
    readonly wsAllowedOrigins: readonly string[];
    readonly storageDir?: string;
    readonly retentionMaxRuns: number;
    readonly snapshotPersistenceBounds: ControlRunSnapshotBounds;
    readonly runtimeRetentionBounds: ControlRunSnapshotBounds;
}

export function readBlackBoxControlServerConfiguration(
    environment: BlackBoxControlEnvironment
): BlackBoxControlServerConfiguration {
    const allowedCommandKinds = readEnvironmentList(
        environment,
        'RALLAR_BLACK_BOX_ALLOWED_COMMANDS'
    );
    return {
        allowedOrigins: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS'),
        requireTls: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_TLS'),
        requireRunToken: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN'),
        requireReadToken: readEnvironmentBoolean(environment, 'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN'),
        adminToken: readEnvironmentString(environment, 'RALLAR_BLACK_BOX_ADMIN_TOKEN'),
        operatorTokenSecret: readEnvironmentString(
            environment,
            'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET'
        ),
        runTokenTtlMs: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS',
            15 * 60_000
        ),
        maxRequestBytes: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_MAX_REQUEST_BYTES',
            2_000_000
        ),
        allowedCommandKinds: allowedCommandKinds.length > 0
            ? allowedCommandKinds as RallarBlackBoxTestCommandKind[]
            : undefined,
        commandRateLimitMax: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX',
            120
        ),
        commandRateLimitWindowMs: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS',
            60_000
        ),
        httpAllowedHosts: readEnvironmentList(
            environment,
            'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS'
        ),
        httpAllowedOrigins: readEnvironmentList(
            environment,
            'RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS'
        ),
        wsAllowedHosts: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS'),
        wsAllowedOrigins: readEnvironmentList(environment, 'RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS'),
        storageDir: readEnvironmentString(environment, 'RALLAR_BLACK_BOX_STORAGE_DIR'),
        retentionMaxRuns: readEnvironmentNumber(
            environment,
            'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS',
            0
        ),
        snapshotPersistenceBounds: readSnapshotBounds(environment, 'SNAPSHOT_PERSIST', {
            commands: 500,
            results: 500,
            events: 1_000,
            stats: 200,
            reports: 100,
            heartbeats: 100
        }),
        runtimeRetentionBounds: readSnapshotBounds(environment, 'RUNTIME_RETAIN', {
            commands: 1_000,
            results: 1_000,
            events: 2_000,
            stats: 500,
            reports: 20,
            heartbeats: 500
        })
    };
}

function readSnapshotBounds(
    environment: BlackBoxControlEnvironment,
    prefix: 'SNAPSHOT_PERSIST' | 'RUNTIME_RETAIN',
    defaults: Required<ControlRunSnapshotBounds>
): ControlRunSnapshotBounds {
    return {
        commands: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_COMMANDS`,
            defaults.commands
        ),
        results: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_RESULTS`,
            defaults.results
        ),
        events: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_EVENTS`,
            defaults.events
        ),
        stats: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_STATS`,
            defaults.stats
        ),
        reports: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_REPORTS`,
            defaults.reports
        ),
        heartbeats: readEnvironmentSnapshotLimit(
            environment,
            `RALLAR_BLACK_BOX_${prefix}_HEARTBEATS`,
            defaults.heartbeats
        )
    };
}

function readEnvironmentString(
    environment: BlackBoxControlEnvironment,
    key: string
): string | undefined {
    const value = environment.get(key)?.trim();
    return value && value.length > 0 ? value : undefined;
}

function readEnvironmentList(
    environment: BlackBoxControlEnvironment,
    key: string
): string[] {
    return (environment.get(key) ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function readEnvironmentNumber(
    environment: BlackBoxControlEnvironment,
    key: string,
    fallback: number
): number {
    const parsed = Number.parseInt(environment.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readEnvironmentBoolean(
    environment: BlackBoxControlEnvironment,
    key: string
): boolean {
    const normalized = (environment.get(key) ?? '').trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
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
    if (normalized === 'all' || normalized === 'unbounded' || normalized === 'none') {
        return undefined;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
