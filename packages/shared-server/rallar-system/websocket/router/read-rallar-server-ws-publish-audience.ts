import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { RallarServerWsFanout, RallarServerWsPublishAudienceReader } from './rallar-server-ws-router-contracts.ts';
import type { RallarServerWsRouter } from './rallar-server-ws-router.ts';

export interface ReadRallarServerWsPublishAudienceInput {
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly serverPeerId: string;
    readonly readRoomAudience: RallarServerWsPublishAudienceReader | undefined;
}

/**
 * A room notification the server itself publishes through the outbox is frozen to the room's live sessions at
 * publish (D58, Q7): its receipt expects them, a session that joins later is not addressed, and one that leaves reads
 * unconfirmed (D43). Every other publish resolves its audience as before (C8).
 */
export async function readRallarServerWsPublishAudience(
    input: ReadRallarServerWsPublishAudienceInput
): Promise<RallarServerWsRouter.PublishAudience | undefined> {
    const { message } = input;
    const serverRoomNotification = input.fanout === 'outbox' &&
        message.id.senderId === input.serverPeerId &&
        message.targets?.mode === 'broadcast' && message.targets.scope === 'room';
    const current = serverRoomNotification ? await input.readRoomAudience?.(message) : undefined;
    return current === undefined
        ? undefined
        : { current, admittedPeerIds: current.sessions.map((session) => session.sessionId) };
}
