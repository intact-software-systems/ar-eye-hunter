import type { CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

export type RallarOperationRetryPredicate = (
    error: unknown,
    attempt: number,
) => boolean;

export type RallarOperationOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxAttempts?: number;
    shouldRetry?: RallarOperationRetryPredicate;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
}>;

export function toRallarWorkflowPolicies<V>(
    options?: RallarOperationOptions,
): CommandsOrchestratorPolicies<V> {
    if (
        !options?.signal &&
        options?.timeoutMs === undefined &&
        options?.maxAttempts === undefined &&
        options?.shouldRetry === undefined
    ) {
        return {};
    }

    return {
        command: toRallarCommandOptions(options),
    };
}

export function toRallarOperationOptions(
    options: RallarOperationOptions,
): RallarOperationOptions {
    if (
        !options.signal &&
        options.timeoutMs === undefined &&
        options.maxAttempts === undefined &&
        options.shouldRetry === undefined &&
        options.dataChannelLanes === undefined &&
        options.maxPeerConnections === undefined &&
        options.rttReportingDegreeLimit === undefined
    ) {
        return {};
    }

    const normalized: {
        signal?: AbortSignal;
        timeoutMs?: number;
        maxAttempts?: number;
        shouldRetry?: RallarOperationRetryPredicate;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
        maxPeerConnections?: number;
        rttReportingDegreeLimit?: number;
    } = {};
    if (options.signal) {
        normalized.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
        normalized.timeoutMs = options.timeoutMs;
    }
    if (options.maxAttempts !== undefined) {
        normalized.maxAttempts = options.maxAttempts;
    }
    if (options.shouldRetry !== undefined) {
        normalized.shouldRetry = options.shouldRetry;
    }
    if (options.dataChannelLanes !== undefined) {
        normalized.dataChannelLanes = options.dataChannelLanes;
    }
    if (options.maxPeerConnections !== undefined) {
        normalized.maxPeerConnections = options.maxPeerConnections;
    }
    if (options.rttReportingDegreeLimit !== undefined) {
        normalized.rttReportingDegreeLimit = options.rttReportingDegreeLimit;
    }

    return normalized;
}

export function toRallarCommandOptions<T>(
    options: RallarOperationOptions,
): CommandOptions<T> {
    const commandOptions: CommandOptions<T> = {};
    if (options.signal) {
        commandOptions.signal = options.signal;
    }
    if (options.timeoutMs !== undefined) {
        commandOptions.timeoutMs = options.timeoutMs;
    }
    if (options.maxAttempts !== undefined) {
        commandOptions.maxAttempts = options.maxAttempts;
    }
    if (options.shouldRetry) {
        commandOptions.shouldRetry = options.shouldRetry;
    } else if (options.maxAttempts !== undefined) {
        commandOptions.shouldRetry = shouldRetryRallarOperation;
    }

    return commandOptions;
}

export function shouldRetryRallarOperation(error: unknown): boolean {
    const status = readHttpStatus(error);
    if (status !== undefined) {
        return status === 429 || status >= 500;
    }

    return true;
}

function readHttpStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status)
        ? status
        : undefined;
}
