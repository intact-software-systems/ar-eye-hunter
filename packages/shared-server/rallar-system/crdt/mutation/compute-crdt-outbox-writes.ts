import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import {
    RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID,
    RALLAR_CRDT_UPDATE_TYPE_ID
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppOutboxInsert,
    computeWsOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import type { WsOutboxProvenance } from '../../websocket/outbox/ws-outbox-provenance.ts';
import type {
    CrdtAppendCommand,
    CrdtMutationCommand,
    CrdtMutationPublicationAuthority,
    CrdtMutationRead
} from './crdt-mutation-contracts.ts';

export interface ComputeCrdtOutboxWritesInput {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly entries: readonly ResourceEntry[];
}

export function computeCrdtOutboxWrites(input: ComputeCrdtOutboxWritesInput): readonly AppOutboxInsert[] {
    const { command, read, entries } = input;
    return entries.map((entry) => {
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            return computeAppOutboxInsert(entry);
        }
        const { append, authority } = requireCrdtPublicationAuthority(command, read);
        const message = decodePersistedALMessage(entry.resource);
        return computeWsOutboxInsert({
            entry,
            admissionNamespace: null,
            provenance: {
                message,
                producerKind: 'crdt',
                target: toCrdtOutboxProvenanceTarget(append, message, authority),
                expiresAtMs: entry.audit.expiryTs.epochMilliseconds
            }
        });
    });
}

interface CrdtPublicationAuthority {
    readonly append: CrdtAppendCommand;
    readonly authority: CrdtMutationPublicationAuthority;
}

function requireCrdtPublicationAuthority(
    command: CrdtMutationCommand,
    read: CrdtMutationRead
): CrdtPublicationAuthority {
    const authority = read.publicationAuthority;
    if (command.operation !== 'append' || authority === null) {
        throw new TypeError('CRDT WS publication requires the authorized append scope and audience');
    }
    const document = command.document;
    if (
        authority.recipientScope.applicationId !== document.applicationId ||
        authority.recipientScope.workspaceId !== (document.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID) ||
        !authority.admittedAudience.includes(command.actor.sessionId)
    ) {
        throw new TypeError('CRDT publication authority differs from the authorized document or actor session');
    }
    return { append: command, authority };
}

function toCrdtOutboxProvenanceTarget(
    command: CrdtAppendCommand,
    message: ALMessage,
    authority: CrdtMutationPublicationAuthority
): WsOutboxProvenance['target'] {
    const targets = message.targets;
    if (message.payload.typeId === RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID) {
        if (targets?.mode !== 'unicast' || targets.toPeerId !== command.actor.sessionId) {
            throw new TypeError('CRDT reply target differs from its authenticated sender session');
        }
        return {
            kind: 'scoped-unicast',
            peerId: command.actor.sessionId,
            scope: authority.recipientScope,
            admittedAudience: [command.actor.sessionId]
        };
    }
    if (message.payload.typeId !== RALLAR_CRDT_UPDATE_TYPE_ID) {
        throw new TypeError('CRDT WS outbox row has an unsupported publication effect');
    }
    if (command.document.scope === 'room' && command.document.roomRef) {
        if (
            targets?.mode !== 'broadcast' || targets.scope !== 'room' ||
            !targets.groupRef || !isSameGroupRef(targets.groupRef, command.document.roomRef)
        ) {
            throw new TypeError('CRDT room fanout differs from the authorized room');
        }
        return {
            kind: 'scoped-room-broadcast',
            groupRef: command.document.roomRef,
            admittedAudience: authority.admittedAudience
        };
    }
    if (command.document.scope === 'principal' && command.document.principalId) {
        if (targets?.mode !== 'unicast' || targets.toPeerId !== command.document.principalId) {
            throw new TypeError('CRDT principal fanout differs from the authorized principal');
        }
        return {
            kind: 'scoped-principal-unicast',
            peerId: command.document.principalId,
            principalRef: { ...authority.recipientScope, principalId: command.document.principalId },
            admittedAudience: authority.admittedAudience
        };
    }
    if (command.document.scope === 'app' && targets?.mode === 'broadcast' && targets.scope === 'world') {
        return { kind: 'scoped-world-broadcast', scope: authority.recipientScope };
    }
    throw new TypeError('CRDT fanout target differs from its authorized document');
}
