import {
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicPublicSnapshot,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import {
    RallarGameAuthorityClient,
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

export interface RelicAuthorityPresence {
    readonly protocolVersion: typeof RELIC_PROTOCOL_VERSION;
    readonly sessionId: string;
    readonly username: string;
    readonly roomId?: string;
    readonly sentAtEpochMs: number;
}

export type RelicAuthoritySnapshotEnvelope = RallarGameAuthorityEnvelope<RelicPublicSnapshot>;

export interface RelicAuthorityClientBridge {
    start(onSnapshot: (event: RelicServerEvent) => void): () => void;
    status(): RallarGameAuthorityClientStatus | undefined;
    publishPresence(session: AuthSession, roomId?: string): Promise<boolean>;
    publishSnapshotRepair(snapshot: RelicPublicSnapshot): Promise<boolean>;
}

interface RelicAuthorityClientBridgeState {
    client?: RallarGameAuthorityClientHandle<
        RelicCommand,
        RelicPublicSnapshot,
        RelicServerEvent,
        RelicAuthorityPresence
    >;
    activeSnapshotHandler?: (event: RelicServerEvent) => void;
}

interface EnsureRelicAuthorityClientInput {
    readonly rallar: RallarGameAuthorityClientRallarFacade;
    readonly state: RelicAuthorityClientBridgeState;
}

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
    const state: RelicAuthorityClientBridgeState = {};
    const ensureClient = () => ensureRelicAuthorityClient({ rallar, state });

    return {
        start(onSnapshot): () => void {
            state.activeSnapshotHandler = onSnapshot;
            const handle = ensureClient();
            void handle.start();
            return () => {
                if (state.activeSnapshotHandler === onSnapshot) {
                    state.activeSnapshotHandler = undefined;
                }
                handle.stop();
                if (state.client === handle) {
                    state.client = undefined;
                }
            };
        },
        status: () => state.client?.status(),
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
}

function ensureRelicAuthorityClient(
    input: EnsureRelicAuthorityClientInput
): RallarGameAuthorityClientHandle<RelicCommand, RelicPublicSnapshot, RelicServerEvent, RelicAuthorityPresence> {
    input.state.client ??= new RallarGameAuthorityClient<
        RelicCommand,
        RelicPublicSnapshot,
        RelicServerEvent,
        RelicAuthorityPresence
    >({
        rallar: input.rallar,
        protocol: RELIC_AUTHORITY_PROTOCOL,
        topicId: RELIC_AUTHORITY_TOPIC_ID,
        authority: RELIC_AUTHORITY_REF,
        peerAssist: {
            enabled: true,
            snapshotRepair: true,
            acceptSnapshotRepair: (envelope) =>
                shouldAcceptRelicAuthoritySnapshotRepair(
                    envelope,
                    input.rallar.rooms.state().currentRoomId
                )
        },
        onSnapshot: (envelope) => {
            input.state.activeSnapshotHandler?.(
                toRelicAuthoritySnapshotEvent(envelope.payload)
            );
        }
    });
    return input.state.client;
}
