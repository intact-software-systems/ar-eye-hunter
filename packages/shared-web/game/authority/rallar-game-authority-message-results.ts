import type { ALOutboundEnqueueStatus } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { RallarGameAuthorityCommandResult, RallarGameAuthoritySendResult } from '@shared/rallar-game/mod.ts';

export function notReadyAuthoritySendResult(
    transport: 'rtc' | 'ws'
): RallarGameAuthoritySendResult {
    return {
        status: 'not-ready',
        transport,
        reason: 'Cannot send without a room and local session.'
    };
}

export function isSuccessfulAuthorityMessageStatus(
    status: ALOutboundEnqueueStatus
): boolean {
    return status === 'enqueued' || status === 'accepted' ||
        status === 'skipped' || status === 'duplicate';
}

export function decodeAuthorityCommandResult(
    value: RallarGameAuthorityCommandResult
): RallarGameAuthorityCommandResult | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Partial<RallarGameAuthorityCommandResult>;
    if (
        typeof candidate.commandSeq !== 'number' ||
        !Number.isSafeInteger(candidate.commandSeq) ||
        candidate.commandSeq < 0 ||
        (candidate.status !== 'accepted' && candidate.status !== 'rejected')
    ) {
        return undefined;
    }
    return {
        commandSeq: candidate.commandSeq,
        status: candidate.status,
        reason: typeof candidate.reason === 'string'
            ? candidate.reason
            : undefined
    };
}
