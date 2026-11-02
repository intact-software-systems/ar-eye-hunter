import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodePartyMutationResult, decodePartyPolicy, decodePartyRequest } from '@shared/api/parties/party-request.ts';
import type { PartyMutationResult, PartyRequest } from '@shared/api/parties/party-request.ts';
import type { PartyPolicy } from '@shared/api/parties/party.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

export interface PartyCommand {
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly requestId: string;
    readonly request: PartyRequest;
    readonly capturedAtEpochMs: number | null;
    readonly policy: PartyPolicy | null;
}

export function decodePartyCommand(value: unknown): PartyCommand {
    const command = requireRecord(value, 'Party command');
    requireExactKeys(command, [
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'requestId',
        'request',
        'capturedAtEpochMs',
        'policy'
    ], 'Party command');
    requireString(command.principalId, 'Party actor');
    requireString(command.sessionId, 'Party issuing session');
    requireString(command.requestId, 'Party request identity');
    requireEpoch(command.sessionIssuedAtEpochMs, 'Party session issuance');
    requireEpoch(command.sessionExpiresAtEpochMs, 'Party session expiry');
    if (command.sessionExpiresAtEpochMs <= command.sessionIssuedAtEpochMs || command.requestId.length > 128) {
        throw new TypeError('Party command session lifetime or request identity is invalid');
    }
    if (command.capturedAtEpochMs !== null) {
        requireEpoch(command.capturedAtEpochMs, 'Party captured timestamp');
    }
    if ((command.capturedAtEpochMs === null) !== (command.policy === null)) {
        throw new TypeError('Party ingress facts must be captured together');
    }
    return {
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        requestId: command.requestId,
        request: decodePartyRequest(command.request),
        capturedAtEpochMs: command.capturedAtEpochMs,
        policy: command.policy === null ? null : decodePartyPolicy(command.policy)
    };
}

export function decodePartyResult(value: unknown, command: PartyCommand): PartyMutationResult {
    const result = decodePartyMutationResult(value);
    if (
        result.principalId !== command.principalId || result.requestId !== command.requestId ||
        !jsonEquals(result.ref, command.request.ref)
    ) {
        throw new TypeError('Party result differs from its retained actor, request or party');
    }
    return result;
}
