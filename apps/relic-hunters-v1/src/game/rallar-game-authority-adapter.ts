import {
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicPublicSnapshot,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import {
    createRallarGameAuthorityClient,
    type RallarGameAuthorityClientHandle,
    type RallarGameAuthorityClientRallarFacade
} from '@shared-web/game/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarGameAuthorityClientStatus,
    RallarGameAuthorityEnvelope,
    RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';

export const RELIC_AUTHORITY_PROTOCOL = 'relic-hunters.authority.v1';
export const RELIC_AUTHORITY_TOPIC_ID = 'relic-hunters.authority';
export const RELIC_AUTHORITY_REF: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'relic-hunter-server-v1',
    epoch: RELIC_PROTOCOL_VERSION
};

export type RelicAuthorityPresence = Readonly<{
    protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    sessionId: string;
    username: string;
    roomId?: string;
    sentAtEpochMs: number;
}>;

export type RelicAuthoritySnapshotEnvelope = RallarGameAuthorityEnvelope<RelicPublicSnapshot>;

export type RelicAuthorityClientBridge = Readonly<{
    start(onSnapshot: (event: RelicServerEvent) => void): () => void;
    status(): RallarGameAuthorityClientStatus | undefined;
    publishPresence(session: AuthSession, roomId?: string): Promise<boolean>;
    publishSnapshotRepair(snapshot: RelicPublicSnapshot): Promise<boolean>;
}>;

export function createRelicAuthorityPresence(
    session: AuthSession,
    roomId?: string,
    nowEpochMs = Date.now()
): RelicAuthorityPresence {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        username: session.username,
        roomId,
        sentAtEpochMs: nowEpochMs
    };
}

export function toRelicAuthoritySnapshotEvent(
    snapshot: RelicPublicSnapshot
): RelicServerEvent {
    return {
        protocolVersion: snapshot.protocolVersion,
        gameId: snapshot.gameId,
        snapshot
    };
}

export function shouldAcceptRelicAuthoritySnapshotRepair(
    envelope: RelicAuthoritySnapshotEnvelope,
    expectedRoomId?: string
): boolean {
    return envelope.authority.kind === RELIC_AUTHORITY_REF.kind &&
        envelope.authority.id === RELIC_AUTHORITY_REF.id &&
        envelope.authority.epoch >= RELIC_AUTHORITY_REF.epoch &&
        (!expectedRoomId || envelope.payload.roomId === expectedRoomId);
}

export function createRelicAuthorityClientBridge(
    rallar: RallarGameAuthorityClientRallarFacade
): RelicAuthorityClientBridge {
    let client:
        | RallarGameAuthorityClientHandle<RelicCommand, RelicPublicSnapshot, RelicServerEvent, RelicAuthorityPresence>
        | undefined;
    let activeSnapshotHandler: ((event: RelicServerEvent) => void) | undefined;

    return {
        start(onSnapshot): () => void {
            activeSnapshotHandler = onSnapshot;
            const handle = ensureClient();
            void handle.start();
            return () => {
                if (activeSnapshotHandler === onSnapshot) {
                    activeSnapshotHandler = undefined;
                }
                handle.stop();
                if (client === handle) {
                    client = undefined;
                }
            };
        },
        status: () => client?.status(),
        async publishPresence(session, roomId): Promise<boolean> {
            const handle = ensureClient();
            await handle.start();
            const result = await handle.publishPresence(
                createRelicAuthorityPresence(session, roomId)
            );
            return result.status === 'sent';
        },
        async publishSnapshotRepair(snapshot): Promise<boolean> {
            const handle = ensureClient();
            await handle.start();
            const result = await handle.publishSnapshotRepair(snapshot);
            return result.status === 'sent';
        }
    };

    function ensureClient(): RallarGameAuthorityClientHandle<
        RelicCommand,
        RelicPublicSnapshot,
        RelicServerEvent,
        RelicAuthorityPresence
    > {
        client ??= createRallarGameAuthorityClient<
            RelicCommand,
            RelicPublicSnapshot,
            RelicServerEvent,
            RelicAuthorityPresence
        >({
            rallar,
            protocol: RELIC_AUTHORITY_PROTOCOL,
            topicId: RELIC_AUTHORITY_TOPIC_ID,
            authority: RELIC_AUTHORITY_REF,
            peerAssist: {
                enabled: true,
                snapshotRepair: true,
                acceptSnapshotRepair: (envelope) =>
                    shouldAcceptRelicAuthoritySnapshotRepair(
                        envelope,
                        rallar.rooms.state().currentRoomId
                    )
            },
            onSnapshot: (envelope) => {
                activeSnapshotHandler?.(
                    toRelicAuthoritySnapshotEvent(envelope.payload)
                );
            }
        });
        return client;
    }
}
