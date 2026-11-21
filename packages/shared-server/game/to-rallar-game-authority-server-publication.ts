import {
    newALBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';

export interface ToRallarGameAuthorityServerPublicationInput<TPayload> {
    readonly protocol: string;
    readonly topicId: string;
    readonly roomId: string;
    readonly kind: RallarGameAuthorityEnvelope<TPayload>['kind'];
    readonly typeId: string;
    readonly payload: TPayload;
    readonly authority: RallarGameAuthorityRef;
    readonly sequence: number;
    readonly sentAtEpochMs: number;
    readonly ttlMs: number;
    readonly roomRef: GroupRef;
    readonly toPeerId?: string;
}

export interface RallarGameAuthorityServerPublication<TPayload> {
    readonly envelope: RallarGameAuthorityEnvelope<TPayload>;
    readonly message: ALMessage;
}

export function toRallarGameAuthorityServerPublication<TPayload>(
    input: ToRallarGameAuthorityServerPublicationInput<TPayload>
): RallarGameAuthorityServerPublication<TPayload> {
    const envelope = createRallarGameAuthorityEnvelope({
        protocol: input.protocol,
        kind: input.kind,
        roomId: input.roomId,
        senderId: input.authority.id,
        seq: input.sequence,
        sentAtEpochMs: input.sentAtEpochMs,
        authority: input.authority,
        payload: input.payload
    });
    const route = newALRoute(
        input.topicId,
        input.roomId,
        `${input.roomId}:${input.kind}:${envelope.seq}`
    );
    const message = input.toPeerId
        ? newALUnicastMessage(
            {
                createdAtEpochMs: input.sentAtEpochMs,
                senderId: input.authority.id,
                route,
                toPeerId: input.toPeerId,
                typeId: input.typeId,
                resource: envelope
            }
        )
        : newALBroadcastMessage(
            {
                createdAtEpochMs: input.sentAtEpochMs,
                senderId: input.authority.id,
                route,
                scope: 'room',
                typeId: input.typeId,
                resource: envelope,
                options: {
                    groupRef: input.roomRef,
                    reliability: 'at-least-once',
                    ttlMs: input.ttlMs
                }
            }
        );

    return { envelope, message };
}
