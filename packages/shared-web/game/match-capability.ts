import type { RallarMessage, RallarRoomState } from '@shared-web/browser/rallar.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarGameEnvelope,
    RallarGameHostCapability,
    RallarGameMatchConfig,
    RallarGameSendResult
} from './types.ts';

interface PublishRallarGameHostCapabilityRoomTarget {
    readonly roomId: string;
    readonly roomRef?: GroupRef;
}

interface PublishRallarGameHostCapabilityInput<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    readonly typeId: string;
    readonly room: PublishRallarGameHostCapabilityRoomTarget;
    readonly envelope: RallarGameEnvelope<RallarGameHostCapability>;
}

export function resolveDefaultRallarGamePeerIds(
    roomState: RallarRoomState,
    localPeerId: string | undefined
): readonly string[] {
    return [
        ...new Set([
            ...roomState.members
                .filter((member) => member.isOnline)
                .flatMap((member) => member.sessionIds),
            ...(localPeerId ? [localPeerId] : [])
        ])
    ].sort((left, right) => left.localeCompare(right));
}

export function decodeRallarGameHostCapability(
    envelope: RallarGameEnvelope<RallarMessage['payload']>
): RallarGameHostCapability | undefined {
    if (
        typeof envelope.payload !== 'object' ||
        envelope.payload === null ||
        Array.isArray(envelope.payload)
    ) {
        return undefined;
    }

    const payload = envelope.payload as Partial<RallarGameHostCapability>;
    return {
        ...payload,
        peerId: envelope.senderId,
        reportedAtEpochMs: typeof payload.reportedAtEpochMs === 'number'
            ? payload.reportedAtEpochMs
            : envelope.sentAtEpochMs
    };
}

export async function publishRallarGameHostCapability<TInput, TIntent, TSnapshot, TEvent, TPresence>(
    input: PublishRallarGameHostCapabilityInput<TInput, TIntent, TSnapshot, TEvent, TPresence>
): Promise<RallarGameSendResult> {
    const ws = await input.config.rallar.messages.ws.send({
        topicId: input.config.topicId,
        typeId: input.typeId,
        payload: input.envelope,
        scope: 'room',
        roomId: input.room.roomRef ? undefined : input.room.roomId,
        roomRef: input.room.roomRef,
        reliability: 'best-effort',
        ack: 'none'
    });
    const sent = isSuccessfulMessageStatus(ws.status);
    return sent
        ? { status: 'sent', transport: 'ws', ws }
        : { status: 'failed', transport: 'ws', ws, reason: ws.reason };
}

function isSuccessfulMessageStatus(status: ALOutboundEnqueueStatus): boolean {
    return status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'skipped' ||
        status === 'duplicate';
}
