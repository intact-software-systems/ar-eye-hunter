import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import {
    decodeGroupMove,
    decodeGroupMoveRef,
    moveIdentifier,
    type GroupMoveClaim
} from '@shared/api/mutation/decode-group-move.ts';
import { GROUP_MOVE_MAX_SESSIONS, type GroupMove } from '@shared/api/mutation/group-move.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupMutationIngress } from '../group-state-service-contracts.ts';
import { decodeGroupStateInboxAuthority } from '../inbox/decode-group-state-inbox-authority.ts';

export interface GroupMoveCredential {
    readonly sessionId: string;
    readonly admission: GroupMutationIngress;
}

/** Private evidence is deliberately outside the public move returned to participants. */
export interface GroupMoveRecord {
    readonly move: GroupMove;
    readonly credentials: readonly GroupMoveCredential[];
}

export function decodeGroupMoveRecord(value: unknown): GroupMoveRecord {
    const record = requireRecord(value, 'Group move record');
    requireExactKeys(record, ['move', 'credentials'], 'Group move record');
    const move = decodeGroupMove(record.move);
    if (!Array.isArray(record.credentials) || record.credentials.length > GROUP_MOVE_MAX_SESSIONS) {
        throw new TypeError('Group move credentials must be a bounded array');
    }
    const credentials = Array.from(record.credentials, decodeGroupMoveCredential);
    if (new Set(credentials.map((credential) => credential.sessionId)).size !== credentials.length) {
        throw new TypeError('Group move credentials repeat a session');
    }
    if (move.status !== 'proposed' && credentials.length !== 0) {
        throw new TypeError('Terminal group moves cannot retain admission credentials');
    }
    if (
        move.status === 'proposed' &&
        credentials.length !== move.participants.filter((participant) => participant.confirmedAtEpochMs !== null).length
    ) {
        throw new TypeError('Each confirmed group move participant requires admission evidence');
    }
    for (const credential of credentials) {
        const participant = move.participants.find((participant) => participant.sessionId === credential.sessionId);
        const { command, authorityProof, facts } = credential.admission;
        if (
            !participant || participant.confirmedAtEpochMs === null || command.operation !== 'joinGroup' ||
            command.input.participation !== 'player' || !isSameGroupRef(command.aggregateRef, move.destination) ||
            command.targetPrincipalId !== participant.principalId ||
            command.input.actorPrincipalId !== participant.principalId ||
            command.input.actorSessionId !== participant.sessionId ||
            authorityProof?.principalId !== participant.principalId ||
            authorityProof.sessionId !== participant.sessionId || facts.internalAuthority !== 'none'
        ) {
            throw new TypeError('Group move admission evidence must bind the confirmed participant and destination');
        }
    }
    return { move, credentials };
}

export function decodeGroupMoveCredential(value: unknown): GroupMoveCredential {
    const credential = requireRecord(value, 'Group move credential');
    requireExactKeys(credential, ['sessionId', 'admission'], 'Group move credential');
    return {
        sessionId: moveIdentifier(credential.sessionId),
        admission: decodeGroupStateInboxAuthority(
            decodeJsonWireValue(credential.admission, 'Group move admission evidence')
        )
    };
}

/** A claim binds its participant slot as well as its proposal identity. Source claims use null. */
export interface StoredGroupMoveClaim extends GroupMoveClaim {
    readonly principalId: string | null;
}

export function decodeStoredGroupMoveClaim(value: unknown): StoredGroupMoveClaim {
    const claim = requireRecord(value, 'Stored group move claim');
    requireExactKeys(claim, ['source', 'moveId', 'principalId'], 'Stored group move claim');
    return {
        source: decodeGroupMoveRef(claim.source),
        moveId: moveIdentifier(claim.moveId),
        principalId: claim.principalId === null ? null : moveIdentifier(claim.principalId)
    };
}
