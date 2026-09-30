import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { Either } from '@shared/resilience/Either.ts';
import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import { filterLiveWsRoomRecipientSessionIds } from '../../queue-pubsub/live-ws-audience.ts';
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
    readonly readServerPublishAudience: RallarServerWsRouterOptions['readServerPublishAudience'];
}

/** The audience a publish is frozen to; none leaves its addressing to the wire targets. */
export interface RallarServerWsPublicationAudience {
    readonly frozen: RallarServerWsRoomAudience | undefined;
}

/** The left value is the room authorizer's refusal of a proxy publish, which then sends nothing. */
export async function readRallarServerWsPublicationAudience(
    input: ReadRallarServerWsPublicationAudienceInput
): Promise<Either<string, RallarServerWsPublicationAudience>> {
    const groupRef = readALTargetGroupRef(input.message);
    if (!groupRef || input.origin === 'admitted' || input.fanout === 'none') {
        return Either.ofRight({ frozen: undefined });
    }
    if (input.origin === 'proxy') {
        const authorization = await authorizeRallarServerWsIngress({
            message: input.message,
            authorizeRoomMessage: input.authorizeRoomMessage
        });
        return authorization.authorized
            ? Either.ofRight({ frozen: authorization.audience })
            : Either.ofLeft(authorization.logMessage);
    }
    return Either.ofRight({ frozen: await input.readServerPublishAudience?.(input.message) });
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
    return filterLiveWsRoomRecipientSessionIds(audience.targets, message.id.senderId, addressedSessionIds);
}

export function isAuthorizedRoomAudience(
    message: ALMessage,
    audience: RallarServerWsRoomAudience,
    nowEpochMs: number
): boolean {
    return JSON.stringify(message.targets) === JSON.stringify(audience.targets) &&
        (message.constraints?.expiresAtMs === undefined || nowEpochMs <= message.constraints.expiresAtMs);
}
