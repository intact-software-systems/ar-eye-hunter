import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import type { WsOutboxProvenanceFacts } from '../../../websocket/outbox/ws-outbox-provenance.ts';

export interface ToClientSnapshotProvenanceFactsInput {
    readonly message: ALMessage;
    readonly principalRef: ClientPrincipalRef;
    readonly principalAudienceSessionIds: readonly string[];
    readonly expiresAtMs: number;
}

/** A state-sync row's proof: a unicast names its peer, a principal broadcast its audience; any other row has none. */
export function toClientSnapshotProvenanceFacts(
    input: ToClientSnapshotProvenanceFactsInput
): WsOutboxProvenanceFacts | null {
    const { message, principalRef, principalAudienceSessionIds, expiresAtMs } = input;
    const targets = message.targets;
    if (targets?.mode !== 'unicast' && !(targets?.mode === 'broadcast' && targets.scope === 'principal')) {
        return null;
    }
    if (
        targets.mode === 'broadcast' && (
            targets.principalRef?.applicationId !== principalRef.applicationId ||
            targets.principalRef.workspaceId !== principalRef.workspaceId ||
            targets.principalRef.principalId !== principalRef.principalId
        )
    ) {
        throw new TypeError('Client state-sync principal target differs from the accepted snapshot');
    }
    return {
        message,
        producerKind: 'state-sync',
        expiresAtMs,
        target: targets.mode === 'unicast'
            ? {
                kind: 'scoped-unicast',
                peerId: targets.toPeerId,
                scope: {
                    applicationId: principalRef.applicationId,
                    workspaceId: principalRef.workspaceId
                },
                admittedAudience: [targets.toPeerId]
            }
            : {
                kind: 'scoped-principal-broadcast',
                principalRef: {
                    applicationId: principalRef.applicationId,
                    workspaceId: principalRef.workspaceId,
                    principalId: principalRef.principalId
                },
                admittedAudience: principalAudienceSessionIds
            }
    };
}
