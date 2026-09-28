import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { authorizeRallarServerWsIngress } from './decode-rallar-server-ws-ingress.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions
} from './rallar-server-ws-router-contracts.ts';

export interface ReadRallarServerWsPublicationAudienceInput {
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly origin: 'server' | 'proxy' | 'admitted' | undefined;
    readonly authorizeRoomMessage: RallarServerWsRouterOptions['authorizeRoomMessage'];
    readonly readServerRoomAudience: NonNullable<
        RallarServerWsRouterOptions['livePublication']
    >['readServerRoomAudience'];
}

export async function readRallarServerWsPublicationAudience(
    input: ReadRallarServerWsPublicationAudienceInput
): Promise<RallarServerWsRoomAudience | undefined> {
    const groupRef = readALTargetGroupRef(input.message);
    if (!groupRef || input.origin === 'admitted' || input.fanout === 'none') {
        return undefined;
    }
    if (input.origin === 'proxy') {
        const authorization = await authorizeRallarServerWsIngress({
            message: input.message,
            authorizeRoomMessage: input.authorizeRoomMessage
        });
        return authorization.authorized ? authorization.audience : undefined;
    }
    return await input.readServerRoomAudience?.(input.message, groupRef);
}

export interface ResolveAuthorizedRoomSessionIdsInput {
    readonly message: ALMessage;
    readonly audience: RallarServerWsRoomAudience;
    readonly admittedPeerIds: readonly string[] | undefined;
    readonly nowEpochMs: number;
}

/** Admission fixes the addressed room audience; socket liveness remains a send-time decision. */
export function resolveAuthorizedRoomSessionIds(input: ResolveAuthorizedRoomSessionIdsInput): readonly string[] {
    const { message, audience, nowEpochMs } = input;
    if (!isAuthorizedRoomAudience(message, audience, nowEpochMs)) {
        return [];
    }
    const addressedSessionIds = input.admittedPeerIds ?? audience.sessions
        .filter((session) => isGroupSnapshotSessionLive(session, nowEpochMs))
        .map((session) => session.sessionId);
    const targets = audience.targets;
    switch (targets.mode) {
        case 'unicast':
            return addressedSessionIds.includes(targets.toPeerId) ? [targets.toPeerId] : [];
        case 'multicast':
            return addressedSessionIds.filter((sessionId) => sessionId !== message.id.senderId);
        case 'broadcast':
            return addressedSessionIds.filter((sessionId) =>
                !targets.exceptPeerIds?.includes(sessionId) &&
                (!targets.recipientPeerIds || targets.recipientPeerIds.includes(sessionId))
            );
    }
}

export function isAuthorizedRoomAudience(
    message: ALMessage,
    audience: RallarServerWsRoomAudience,
    nowEpochMs: number
): boolean {
    return JSON.stringify(message.targets) === JSON.stringify(audience.targets) &&
        (message.constraints?.expiresAtMs === undefined || nowEpochMs <= message.constraints.expiresAtMs);
}
