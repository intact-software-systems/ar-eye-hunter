import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameEnvelope, RallarGameEnvelopeKind } from '../envelopes.ts';
import type { RallarGameMatchConfig } from '../match/rallar-game-match-contracts.ts';
import type { RallarGameMatchStatus } from '../match/rallar-game-match-status.ts';
import type { RallarGameLaneIds } from './lanes.ts';
import type { RallarGamePresenceSendOptions } from './rallar-game-presence-send-options.ts';
import type { RallarGameSendResult } from './rallar-game-send-result.ts';
import { toRallarGameRoomRealtimeSendResult } from './to-rallar-game-realtime-send-result.ts';

export namespace RallarGamePresenceEgressRuntime {
    export interface RoomTarget {
        readonly roomId?: string;
        readonly roomRef?: GroupRef;
    }

    export interface EnvelopeOptions {
        readonly directorEpoch: number;
        readonly roomId?: string;
        readonly senderId?: string;
        readonly sentAtEpochMs?: number;
    }

    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly laneIds: RallarGameLaneIds;
        isStopped(): boolean;
        readStatus(): RallarGameMatchStatus;
        readRoomTarget(): RoomTarget;
        createEnvelope<T>(
            kind: RallarGameEnvelopeKind,
            payload: T,
            options: EnvelopeOptions
        ): RallarGameEnvelope<T>;
    }
}

/** Owns room presence delivery through the room realtime facade. */
export class RallarGamePresenceEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGamePresenceEgressRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;

    constructor(
        input: RallarGamePresenceEgressRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    async send(
        presence: TPresence,
        options: RallarGamePresenceSendOptions = {}
    ): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
        }

        const room = this.input.readRoomTarget();
        if (!room.roomId) {
            return {
                status: 'not-ready',
                transport: 'realtime',
                reason: 'Cannot send presence without a room.'
            };
        }

        const envelope = this.input.createEnvelope('presence', presence, {
            directorEpoch: this.input.readStatus().directorEpoch ?? 0
        });
        const laneId = options.laneId ?? this.input.laneIds.input;
        const key = options.key ?? `presence:${envelope.senderId}`;
        const maxAgeMs = options.maxAgeMs ?? 250;
        const openTimeoutMs = options.openTimeoutMs ?? 500;
        const realtime = await this.input.config.rallar.realtime
            .room({
                laneId,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef,
                openTimeoutMs
            })
            .send(envelope, { key, maxAgeMs });

        return toRallarGameRoomRealtimeSendResult(realtime);
    }
}
