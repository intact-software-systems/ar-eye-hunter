import type { GroupMoveRequest } from '@shared/api/mutation/group-move.ts';

import { requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeGroupMoveRef, moveIdentifier } from '@shared/api/mutation/decode-group-move.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationAuthorityProof, GroupMutationIngress } from '../group-state-service-contracts.ts';
import {
    decodeGroupMutationAuthorityProof,
    decodeGroupStateInboxAuthority
} from '../inbox/decode-group-state-inbox-authority.ts';

export interface GroupMoveCommand extends GroupMoveRequest {
    readonly actorPrincipalId: string;
    readonly actorSessionId: string;
}

export interface GroupMoveIngress {
    readonly command: GroupMoveCommand;
    readonly atEpochMs: number;
    readonly admission: GroupMutationIngress | null;
    readonly authorityProof: GroupMutationAuthorityProof;
}

const REQUEST_KEYS = ['requestId', 'moveId', 'source', 'destination', 'action', 'joinCode', 'inviteToken'] as const;

export function decodeGroupMoveRequest(value: unknown): GroupMoveRequest {
    const request = requireRecord(value, 'Group move request');
    requireExactKeys(request, REQUEST_KEYS, 'Group move request');
    const action = requireOneOf(
        request.action,
        ['propose', 'confirm', 'withdraw', 'decline', 'cancel', 'commit', 'arrive'] as const,
        'Group move action'
    );
    const joinCode = request.joinCode === null ? null : moveIdentifier(request.joinCode);
    const inviteToken = request.inviteToken === null ? null : moveIdentifier(request.inviteToken);
    if (action !== 'confirm' && (joinCode !== null || inviteToken !== null)) {
        throw new TypeError('Admission credentials belong only to confirmation');
    }
    return {
        requestId: moveIdentifier(request.requestId),
        moveId: moveIdentifier(request.moveId),
        source: decodeGroupMoveRef(request.source),
        destination: decodeGroupMoveRef(request.destination),
        action,
        joinCode,
        inviteToken
    };
}

export function decodeGroupMoveCommand(value: unknown): GroupMoveCommand {
    const command = requireRecord(value, 'Group move command');
    requireExactKeys(command, [...REQUEST_KEYS, 'actorPrincipalId', 'actorSessionId'], 'Group move command');
    const { actorPrincipalId, actorSessionId, ...request } = command;
    return {
        ...decodeGroupMoveRequest(request),
        actorPrincipalId: moveIdentifier(actorPrincipalId),
        actorSessionId: moveIdentifier(actorSessionId)
    };
}

export function decodeGroupMoveIngress(value: unknown): GroupMoveIngress {
    const ingress = requireRecord(value, 'Group move ingress');
    requireExactKeys(ingress, ['command', 'atEpochMs', 'admission', 'authorityProof'], 'Group move ingress');
    const command = decodeGroupMoveCommand(ingress.command);
    const authorityProof = decodeGroupMutationAuthorityProof(ingress.authorityProof);
    if (
        typeof ingress.atEpochMs !== 'number' || !Number.isSafeInteger(ingress.atEpochMs) || ingress.atEpochMs < 0 ||
        authorityProof.principalId !== command.actorPrincipalId || authorityProof.sessionId !== command.actorSessionId
    ) {
        throw new TypeError('Group move ingress authority or timestamp differs');
    }
    const admission = ingress.admission === null
        ? null
        : decodeGroupStateInboxAuthority(decodeJsonWireValue(ingress.admission, 'Group move admission'));
    if ((command.action === 'confirm') !== (admission !== null)) {
        throw new TypeError('Group move confirmation must capture admission evidence');
    }
    return { command, authorityProof, admission, atEpochMs: ingress.atEpochMs };
}
