import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import type { RtcGroupFormationMode } from '@shared/rtc/group-formation-mode.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

export type RallarOperationRetryPredicate = (
    error: unknown,
    attempt: number
) => boolean;

export type RallarOperationOptions = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxAttempts?: number;
    shouldRetry?: RallarOperationRetryPredicate;
    dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    maxPeerConnections?: number;
    rttReportingDegreeLimit?: number;
    groupFormationMode?: RtcGroupFormationMode;
    bootstrapDegree?: number;
}>;

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
        options.groupFormationMode === undefined &&
        options.bootstrapDegree === undefined
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
        groupFormationMode?: RtcGroupFormationMode;
        bootstrapDegree?: number;
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
    if (options.groupFormationMode !== undefined) {
        normalized.groupFormationMode = options.groupFormationMode;
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
        commandOptions.shouldRetry = options.shouldRetry;
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
