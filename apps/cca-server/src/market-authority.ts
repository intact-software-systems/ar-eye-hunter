import type { RallarServerWsRouter } from '@shared-server/mod.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    isMarketInput,
    MARKET_INPUT_TOPIC,
    MARKET_STATE_TOPIC,
    type MarketInputMessage,
    type MarketSnapshot
} from '../../../packages/cca-game/market-protocol.ts';
import {
    computeMarketTick,
    createMarket,
    createRunner,
    type MarketControl,
    type MarketState
} from '../../../packages/cca-game/market-rules.ts';

interface MarketController {
    readonly controller: string;
    readonly sequence: number;
    readonly receivedAt: number;
    readonly control: MarketControl;
}
interface MarketRoom {
    readonly generation: number;
    readonly roomRef: GroupRef;
    state: MarketState;
    readonly controllers: Map<string, MarketController>;
    lastInputAt: number;
}
export namespace MarketAuthority {
    export interface Dependencies {
        readonly ws: Pick<RallarServerWsRouter, 'defineTopic' | 'on' | 'publish'>;
        readonly now: () => number;
        readonly serverId: string;
        readonly incarnation: string;
    }
}
export class MarketAuthority {
    private readonly dependencies: MarketAuthority.Dependencies;
    private readonly rooms = new Map<string, MarketRoom>();
    private unsubscribe: (() => boolean) | undefined;
    private publishing = false;
    private nextGeneration = 0;
    constructor(dependencies: MarketAuthority.Dependencies) {
        this.dependencies = dependencies;
    }
    start(): void {
        const { ws, serverId } = this.dependencies;
        ws.defineTopic({
            topicId: MARKET_INPUT_TOPIC,
            typeId: 'input',
            scope: 'room',
            participation: 'members',
            fanout: 'none',
            maxPayloadBytes: 8192,
            validate: isMarketInput
        });
        ws.defineTopic({
            topicId: MARKET_STATE_TOPIC,
            typeId: 'state',
            scope: 'room',
            participation: 'server',
            serverProducerIds: [serverId],
            fanout: 'live-only'
        });
        this.unsubscribe = ws.on<MarketInputMessage>(
            { topicId: MARKET_INPUT_TOPIC, typeId: 'input' },
            (message, context) => {
                if (context.roomRef && isSameGroupRef(context.roomRef, message.payload.roomRef)) {
                    this.acceptInput(message.payload, context.senderId);
                }
            }
        );
    }
    acceptInput(input: MarketInputMessage, sessionId: string): void {
        if (!isMarketInput(input) || input.incarnation !== this.dependencies.incarnation) {
            return;
        }
        const now = this.dependencies.now();
        let room = this.rooms.get(input.roomRef.groupId);
        if (!room) {
            if (this.rooms.size >= 16) {
                return;
            }
            room = {
                generation: ++this.nextGeneration,
                roomRef: input.roomRef,
                state: createMarket(),
                controllers: new Map(),
                lastInputAt: now
            };
            this.rooms.set(input.roomRef.groupId, room);
        }
        const prior = room.controllers.get(sessionId);
        if (prior && prior.controller !== input.controller && now - prior.receivedAt < 1000) {
            return;
        }
        if (prior?.controller === input.controller && input.sequence <= prior.sequence) {
            return;
        }
        if (!prior && room.controllers.size >= 2) {
            return;
        }
        if (!prior) {
            const colour = room.state.players.some((player) => player.colour === 0) ? 1 : 0;
            room.state = {
                ...room.state,
                players: [
                    ...room.state.players,
                    { ...createRunner(sessionId, colour), lastDash: input.dash }
                ]
            };
        }
        else if (prior.controller !== input.controller) {
            room.state = {
                ...room.state,
                players: room.state.players.map((player) =>
                    player.id === sessionId ? { ...player, lastDash: input.dash } : player
                )
            };
        }
        room.controllers.set(sessionId, {
            controller: input.controller,
            sequence: input.sequence,
            receivedAt: now,
            control: { id: sessionId, x: input.x, y: input.y, bank: input.bank, dash: input.dash }
        });
        room.lastInputAt = now;
    }
    tick(): void {
        const now = this.dependencies.now();
        for (const [id, room] of this.rooms) {
            if (now - room.lastInputAt > 60_000) {
                this.rooms.delete(id);
                continue;
            }
            const controls = [...room.controllers.values()].filter((controller) => now - controller.receivedAt < 250)
                .map((controller) => controller.control);
            room.state = computeMarketTick(room.state, controls, 1 / 30);
            this.expirePlayers(room, now);
        }
    }
    async publish(): Promise<void> {
        if (this.publishing) {
            return;
        }
        this.publishing = true;
        try {
            for (const room of this.rooms.values()) {
                await this.publishRoom(room);
            }
        }
        finally {
            this.publishing = false;
        }
    }
    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.rooms.clear();
    }
    getState(roomId: string): MarketState | undefined {
        return this.rooms.get(roomId)?.state;
    }
    private expirePlayers(room: MarketRoom, now: number): void {
        for (const [id, controller] of room.controllers) {
            if (now - controller.receivedAt > 10_000) {
                room.controllers.delete(id);
                room.state = { ...room.state, players: room.state.players.filter((player) => player.id !== id) };
            }
        }
    }
    private async publishRoom(room: MarketRoom): Promise<void> {
        const { serverId, incarnation, ws } = this.dependencies;
        const snapshot: MarketSnapshot = {
            version: 1,
            generation: room.generation,
            roomRef: room.roomRef,
            incarnation,
            state: room.state
        };
        const message = newALBroadcastMessage(
            serverId,
            newALRoute(MARKET_STATE_TOPIC, room.roomRef.groupId, `${incarnation}:${room.state.tick}`),
            'room',
            'state',
            snapshot,
            { groupRef: room.roomRef, reliability: 'best-effort', ttlMs: 250 }
        );
        const result = await ws.publish({ message, producerId: serverId, fanout: 'live-only' });
        if (!['sent-live', 'cluster-published', 'no-recipients', 'none', 'skipped'].includes(result.status)) {
            console.warn('Market snapshot unavailable:', result.status);
        }
    }
}
