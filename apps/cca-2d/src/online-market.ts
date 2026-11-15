import { rallar, type RallarMessage, type RallarRoomSession } from '@shared-web/browser/rallar.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    MARKET_INPUT_TOPIC,
    MARKET_SCOPE,
    MARKET_STATE_TOPIC,
    type MarketInputMessage,
    type MarketSnapshot
} from '../../../packages/cca-game/market-protocol.ts';
import { createMarket, type MarketControl, type MarketState } from '../../../packages/cca-game/market-rules.ts';
import type { MarketSession } from './market-session.ts';

export interface MarketConnection {
    readonly incarnation: string;
    readonly serverId: string;
}
export interface OpenOnlineMarket {
    readonly username: string;
    readonly password: string;
    readonly roomId: string;
    readonly signal: AbortSignal;
    readonly apiBaseUrl: string;
}

export async function openOnlineMarket(request: OpenOnlineMarket): Promise<OnlineMarket> {
    const response = await fetch(`${request.apiBaseUrl}/api/cca`, { signal: request.signal });
    if (!response.ok) {
        throw new Error('The market server is unavailable. Solo practice still works.');
    }
    const connection: MarketConnection = await response.json();
    if (typeof connection.incarnation !== 'string' || typeof connection.serverId !== 'string') {
        throw new Error('The market server returned an incompatible response.');
    }
    await rallar.setup({
        apiBaseUrl: request.apiBaseUrl,
        ...MARKET_SCOPE,
        start: { connect: false, refreshRooms: false, signal: request.signal }
    });
    await rallar.auth.login({ username: request.username, password: request.password });
    request.signal.throwIfAborted();
    await rallar.start({ connect: true, refreshRooms: true, signal: request.signal });
    const room = request.roomId
        ? await rallar.rooms.enter({ ...MARKET_SCOPE, groupId: request.roomId }, { signal: request.signal })
        : rallar.rooms.session(
            (await rallar.rooms.createAndSwitch({ displayName: 'Pocket Arcade Market', joinMode: 'open' })).group
        );
    request.signal.throwIfAborted();
    const playerId = rallar.session()?.sessionId;
    if (!playerId) {
        throw new Error('Sign in before entering a market.');
    }
    return new OnlineMarket(room, playerId, connection);
}

export class OnlineMarket implements MarketSession {
    readonly playerId: string;
    readonly roomId: string;
    private readonly room: RallarRoomSession;
    private readonly connection: MarketConnection;
    private readonly controller = crypto.randomUUID();
    private readonly inputChannel;
    private readonly unsubscribe: () => void;
    private state = createMarket();
    private sequence = 0;
    private lastSent = 0;
    private lastSnapshot = performance.now();
    private sending = false;
    private stopped = false;
    private failure = '';
    private lastControlDash = 0;
    private dashSequence = 0;
    constructor(room: RallarRoomSession, playerId: string, connection: MarketConnection) {
        this.room = room;
        this.roomId = room.roomRef.groupId;
        this.playerId = playerId;
        this.connection = connection;
        this.inputChannel = room.message<MarketInputMessage>({
            topicId: MARKET_INPUT_TOPIC,
            typeId: 'input',
            purpose: 'live',
            access: 'members',
            publication: { cadenceMs: 50, retainNewest: 1, drain: { messages: 1, bytes: 8192 } }
        });
        this.unsubscribe = room.message<MarketSnapshot>({
            topicId: MARKET_STATE_TOPIC,
            typeId: 'state',
            purpose: 'notification',
            access: 'members'
        })
            .onWs((_snapshot, message) => this.acceptSnapshot(message));
    }
    getState(): MarketState {
        return this.state;
    }
    getStatus(): string {
        if (this.failure) {
            return this.failure;
        }
        if (performance.now() - this.lastSnapshot > 1000) {
            return 'RECONNECTING — INPUT STOPPED';
        }
        return this.state.players.some((player) => player.id === this.playerId)
            ? `ONLINE · ${this.state.players.length}/2 PLAYERS`
            : 'JOINING MARKET…';
    }
    advance(_seconds: number, control: MarketControl): void {
        const now = performance.now();
        const stale = now - this.lastSnapshot > 1000;
        if (control.dash > this.lastControlDash && !stale) {
            this.dashSequence += 1;
        }
        this.lastControlDash = control.dash;
        if (this.stopped || this.sending || now - this.lastSent < 50) {
            return;
        }
        this.lastSent = now;
        const input: MarketInputMessage = {
            version: 1,
            roomRef: this.room.roomRef,
            incarnation: this.connection.incarnation,
            controller: this.controller,
            sequence: ++this.sequence,
            x: stale ? 0 : control.x,
            y: stale ? 0 : control.y,
            bank: !stale && control.bank,
            dash: this.dashSequence
        };
        void this.writeInput(input);
    }
    stop(): void {
        this.stopped = true;
        this.unsubscribe();
    }
    private async writeInput(input: MarketInputMessage): Promise<void> {
        this.sending = true;
        try {
            const delivery = await this.inputChannel.sendWs(input, { resourceId: this.controller, ttlMs: 250 });
            const outcome = await delivery.wait({ timeoutMs: 350 });
            if (['rejected', 'failed'].includes(outcome.lifecycle.state)) {
                this.failure = 'CONNECTION INTERRUPTED — RE-ENTER THE MARKET';
            }
        }
        catch {
            this.failure = 'CONNECTION INTERRUPTED — RE-ENTER THE MARKET';
        }
        finally {
            this.sending = false;
        }
    }
    private acceptSnapshot(message: RallarMessage<MarketSnapshot>): void {
        const target = readALTargetGroupRef(message.raw);
        const snapshot = message.payload;
        if (
            this.stopped || message.senderId !== this.connection.serverId || !target ||
            !isSameGroupRef(target, this.room.roomRef)
        ) {
            return;
        }
        if (
            snapshot.version !== 1 || snapshot.incarnation !== this.connection.incarnation ||
            !isSameGroupRef(snapshot.roomRef, this.room.roomRef)
        ) {
            return;
        }
        if (
            !snapshot.state || !Array.isArray(snapshot.state.players) || !Array.isArray(snapshot.state.coins) ||
            snapshot.state.tick <= this.state.tick
        ) {
            return;
        }
        this.state = snapshot.state;
        this.lastSnapshot = performance.now();
        this.failure = '';
    }
}
