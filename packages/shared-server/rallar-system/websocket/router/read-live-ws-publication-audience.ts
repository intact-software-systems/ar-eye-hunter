import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { resolveWsQueueBoxServerProvenScope } from '@shared/services/ws-queue-box-server/scope/resolve-ws-queue-box-server-recipient-scope.ts';
import { resolveLiveWsRoomGroupRef } from '../../queue-pubsub/live-ws-audience.ts';
import type { LiveWsAudience } from '../../queue-pubsub/live-ws-notice.ts';
import type { PublishRallarServerWsMessageInput } from './publish-rallar-server-ws-message.ts';
import { resolveAuthorizedRoomSessionIds } from './rallar-server-ws-publication-audience.ts';

export async function readLiveWsPublicationAudience(
    input: PublishRallarServerWsMessageInput
): Promise<LiveWsAudience | undefined> {
    const targets = input.message.targets;
    if (!targets) {
        return undefined;
    }
    if (targets.mode === 'unicast') {
        return { mode: 'peer', recipientSessionIds: [targets.toPeerId] };
    }
    if (
        targets.mode === 'multicast' || targets.scope === 'room' ||
        (targets.scope === 'principal' && targets.groupRef !== undefined)
    ) {
        return toRoomLiveWsPublicationAudience(input);
    }
    if (targets.scope === 'principal') {
        if (!targets.principalRef || !input.livePublication?.readPrincipalSessionIds) {
            return undefined;
        }
        const sessions = await input.livePublication.readPrincipalSessionIds(targets.principalRef);
        if (!sessions) {
            return undefined;
        }
        return {
            mode: 'principal',
            principalRef: targets.principalRef,
            recipientSessionIds: sessions.filter((id) =>
                !targets.exceptPeerIds?.includes(id) &&
                (targets.recipientPeerIds === undefined || targets.recipientPeerIds.includes(id))
            )
        };
    }
    return { mode: 'broad', targetMode: targets.scope };
}

/** A principal broadcast that names its room is a room audience, so it takes the room notice and its inbound key. */
function toRoomLiveWsPublicationAudience(input: PublishRallarServerWsMessageInput): LiveWsAudience | undefined {
    const groupRef = resolveLiveWsRoomGroupRef(input.message);
    if (!input.audience || !groupRef) {
        return undefined;
    }
    const recipientSessionIds = resolveAuthorizedRoomSessionIds({
        message: input.message,
        audience: input.audience,
        admittedPeerIds: input.admittedPeerIds,
        topic: input.topic,
        nowEpochMs: input.nowEpochMs
    });
    if (input.topic.participation === 'server') {
        const captured = input.audience.recipientConnectionGenerationIds;
        const sessions = recipientSessionIds.filter((id) => Object.hasOwn(captured, id) && captured[id].length > 0);
        return {
            mode: 'generation-room',
            groupRef,
            recipientSessionIds: sessions,
            generations: Object.fromEntries(sessions.map((id) => [id, captured[id]]))
        };
    }
    return { mode: 'room', groupRef, recipientSessionIds };
}

export function resolveLiveWsPublicationScope(
    message: ALMessage,
    audience: LiveWsAudience,
    inboundScope: StateScope | null | undefined
): Either<string, StateScope> {
    if (audience.mode === 'room' || audience.mode === 'generation-room') {
        const { applicationId, workspaceId } = audience.groupRef;
        return Either.ofRight({ applicationId, workspaceId });
    }
    const targets = message.targets;
    if (targets?.mode === 'broadcast' && targets.scope === 'principal' && targets.principalRef) {
        const { applicationId, workspaceId } = targets.principalRef;
        return Either.ofRight({ applicationId, workspaceId });
    }
    const provenScope = resolveWsQueueBoxServerProvenScope(message, inboundScope);
    return provenScope
        ? Either.ofRight(provenScope)
        : Either.ofLeft('Scoped live WS publication has no full recipient scope.');
}
