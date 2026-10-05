import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { CommandOptions } from '@shared/cache/Command.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/web-rtc-connection-service.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export type RallarOperationRetryPredicate = (
    error: Error,
    attempt: number
) => boolean;

export interface RallarOperationOptions {
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
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
    const parsed = parseRtcCaptureMode(options.rtcCaptureMode);
    if (parsed.left) {
        throw new Error(parsed.left[0].message);
    }
    return {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.shouldRetry !== undefined ? { shouldRetry: options.shouldRetry } : {}),
        ...(options.dataChannelLanes !== undefined ? { dataChannelLanes: options.dataChannelLanes } : {}),
        ...(options.maxPeerConnections !== undefined ? { maxPeerConnections: options.maxPeerConnections } : {}),
        ...(options.rttReportingDegreeLimit !== undefined
            ? { rttReportingDegreeLimit: options.rttReportingDegreeLimit }
            : {}),
        ...(options.bootstrapDegree !== undefined ? { bootstrapDegree: options.bootstrapDegree } : {}),
        ...(options.rtcCaptureMode !== undefined ? { rtcCaptureMode: options.rtcCaptureMode } : {})
    };
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
