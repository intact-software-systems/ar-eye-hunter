import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import {
    decodeFriendsMutationResult,
    decodeFriendsRequest,
    type FriendsMutationResult
} from '@shared/api/friends/friends-request.ts';

import type { FriendsCommand } from './friends-mutation-contracts.ts';

export function decodeFriendsCommand(value: unknown): FriendsCommand {
    const command = requireRecord(value, 'Friends command');
    requireExactKeys(command, [
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'requestId',
        'request',
        'capturedAtEpochMs'
    ], 'Friends command');
    requireString(command.principalId, 'Friends actor');
    requireString(command.sessionId, 'Friends session');
    requireString(command.requestId, 'Friends request identity');
    requireEpoch(command.sessionIssuedAtEpochMs, 'Friends session issuance');
    requireEpoch(command.sessionExpiresAtEpochMs, 'Friends session expiry');
    if (command.sessionExpiresAtEpochMs <= command.sessionIssuedAtEpochMs || command.requestId.length > 128) {
        throw new TypeError('Friends command session lifetime or request identity is invalid');
    }
    if (command.capturedAtEpochMs !== null) {
        requireEpoch(command.capturedAtEpochMs, 'Friends captured timestamp');
    }
    return {
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        requestId: command.requestId,
        request: decodeFriendsRequest(command.request),
        capturedAtEpochMs: command.capturedAtEpochMs
    };
}

export function decodeFriendsResult(value: unknown, command: FriendsCommand): FriendsMutationResult {
    const result = decodeFriendsMutationResult(value);
    if (result.principalId !== command.principalId || result.requestId !== command.requestId) {
        throw new TypeError('Friends result differs from its retained actor or request');
    }
    return result;
}
