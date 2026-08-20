import { createDeterministicAvatarProfile, validateAvatarProfile } from '../avatarProfile.ts';
import type {
    DirectorAttemptSource,
    DirectorAttemptState,
    HttpProbeDiagnostics,
} from './arena-connection-contracts.ts';
import type { PlayerPose } from '../types.ts';

interface HttpProbeValue {
    readonly apiBaseUrl?: string;
    readonly wsBaseUrl?: string;
    readonly iceServers?: readonly object[];
}

interface DirectorAttemptStateInput {
    readonly source: DirectorAttemptSource;
    readonly startedAtEpochMs: number;
    readonly resultStatus: string;
    readonly reason?: string;
}

export function toErrorMessage(
    error: Error | string | number | boolean | null | undefined,
): string {
    return error instanceof Error ? error.message : String(error);
}

export function toDirectorAttemptState(
    input: DirectorAttemptStateInput,
): DirectorAttemptState {
    const finishedAtEpochMs = Date.now();
    return {
        source: input.source,
        status: toDirectorAttemptStatus(input.resultStatus),
        resultStatus: input.resultStatus,
        reason: input.reason,
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs,
        durationMs: finishedAtEpochMs - input.startedAtEpochMs,
    };
}

function toDirectorAttemptStatus(
    resultStatus: string,
): DirectorAttemptState['status'] {
    switch (resultStatus) {
        case 'appointed':
            return 'succeeded';
        case 'not-elected':
        case 'not-authorized':
            return 'not-elected';
        case 'not-ready':
            return 'not-ready';
        case 'failed':
        case 'no-local-peer':
        default:
            return 'failed';
    }
}

export function withValidatedAvatarProfile(pose: PlayerPose): PlayerPose {
    const validation = validateAvatarProfile(pose.avatarProfile, pose.sessionId);
    return {
        ...pose,
        avatarProfile: validation.ok
            ? validation.profile
            : createDeterministicAvatarProfile(pose.sessionId, pose.username),
    };
}

export async function probeHttp(
    operation: (signal: AbortSignal) => Promise<HttpProbeValue>,
    parentSignal?: AbortSignal,
): Promise<HttpProbeDiagnostics> {
    if (parentSignal?.aborted) return { status: 'idle' };
    const controller = new AbortController();
    const startedAtEpochMs = Date.now();
    const timeout = window.setTimeout(() => controller.abort(), 2_500);
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    try {
        const value = await operation(controller.signal);
        if (parentSignal?.aborted) return { status: 'idle' };
        return {
            status: 'ok',
            checkedAtEpochMs: Date.now(),
            durationMs: Date.now() - startedAtEpochMs,
            detail: summarizeProbeValue(value),
        };
    } catch (error) {
        return {
            status: 'error',
            checkedAtEpochMs: Date.now(),
            durationMs: Date.now() - startedAtEpochMs,
            reason: toErrorMessage(
                error instanceof Error ? error : new Error(String(error)),
            ),
        };
    } finally {
        parentSignal?.removeEventListener('abort', abort);
        window.clearTimeout(timeout);
    }
}

function summarizeProbeValue(value: HttpProbeValue): string | undefined {
    if (value.iceServers) return `${value.iceServers.length} ICE servers`;
    if (value.apiBaseUrl || value.wsBaseUrl) {
        return [value.apiBaseUrl, value.wsBaseUrl].filter(Boolean).join(' / ');
    }
    return undefined;
}
