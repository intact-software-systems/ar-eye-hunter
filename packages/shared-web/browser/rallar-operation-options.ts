import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';

export type RallarOperationRetryPredicate = (
    error: Error,
    attempt: number
) => boolean;

export interface RallarOperationOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly shouldRetry?: RallarOperationRetryPredicate;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
    readonly rttReportingDegreeLimit?: number;
    readonly bootstrapDegree?: number;
}

export function toRallarWorkflowPolicies<V>(
    options?: RallarOperationOptions
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
        command: toRallarCommandOptions(options)
    };
}

export function toRallarOperationOptions(
    options: RallarOperationOptions
): RallarOperationOptions {
    if (
        !options.signal &&
        options.timeoutMs === undefined &&
        options.maxAttempts === undefined &&
        options.shouldRetry === undefined &&
        options.dataChannelLanes === undefined &&
        options.maxPeerConnections === undefined &&
        options.rttReportingDegreeLimit === undefined &&
        options.bootstrapDegree === undefined
    ) {
        return {};
    }

    const normalized: { -readonly [Key in keyof RallarOperationOptions]: RallarOperationOptions[Key]; } = {};
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
    if (options.bootstrapDegree !== undefined) {
        normalized.bootstrapDegree = options.bootstrapDegree;
    }

    return normalized;
}

export function toRallarCommandOptions<T>(
    options: RallarOperationOptions
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
        const shouldRetry = options.shouldRetry;
        commandOptions.shouldRetry = (error, attempt) => shouldRetry(toError(error), attempt);
    }
    else if (options.maxAttempts !== undefined) {
        commandOptions.shouldRetry = shouldRetryRallarOperation;
    }

    return commandOptions;
}

export function shouldRetryRallarOperation(error: unknown): boolean {
    if (error instanceof ApiHttpError) {
        return error.status === 429 || error.status >= 500;
    }

    return true;
}
