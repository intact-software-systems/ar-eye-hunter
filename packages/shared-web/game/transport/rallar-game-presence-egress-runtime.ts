import type { RallarRoomRealtimeSendResult, RallarRtcStatus } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameEnvelope, RallarGameEnvelopeKind } from '../envelopes.ts';
import type { RallarGameMatchConfig } from '../match/rallar-game-match-contracts.ts';
import type { RallarGamePeerReadiness } from '../match/rallar-game-match-egress-contracts.ts';
import type { RallarGameMatchStatus } from '../match/rallar-game-match-status.ts';
import type { RallarGameLaneIds } from './lanes.ts';
import type { RallarGamePresenceSendOptions } from './rallar-game-presence-send-options.ts';
import type { RallarGameSendResult } from './rallar-game-send-result.ts';
import {
    toRallarGameRealtimeSendResult,
    toRallarGameRoomRealtimeSendResult
} from './to-rallar-game-realtime-send-result.ts';

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
        readLocalPeerId(): string | undefined;
        readPeerReadiness(): RallarGamePeerReadiness | undefined;
        createEnvelope<T>(
            kind: RallarGameEnvelopeKind,
            payload: T,
            options: EnvelopeOptions
        ): RallarGameEnvelope<T>;
    }

    export interface FallbackInput<TPresence> {
        readonly room: RoomTarget;
        readonly envelope: RallarGameEnvelope<TPresence>;
        readonly laneId: string;
        readonly key: string;
        readonly maxAgeMs: number;
        readonly openTimeoutMs: number;
        readonly realtime: RallarRoomRealtimeSendResult;
        readonly roomResult: RallarGameSendResult;
    }
}

/** Owns room presence delivery and its ready-peer realtime recovery path. */
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
        const realtime = await this.input.config.rallar.realtime.room({
            laneId,
            roomId: room.roomRef ? undefined : room.roomId,
            roomRef: room.roomRef,
            openTimeoutMs
        }).send(envelope, { key, maxAgeMs });

        const roomResult = toRallarGameRoomRealtimeSendResult(realtime);
        if (roomResult.status === 'sent' || roomResult.status === 'partial') {
            return roomResult;
        }
        if (realtime.status !== 'no-targets' && realtime.status !== 'not-ready') {
            return roomResult;
        }

        return await this.sendFallback({
            room,
            envelope,
            laneId,
            key,
            maxAgeMs,
            openTimeoutMs,
            realtime,
            roomResult
        });
    }

    private async sendFallback(
        input: RallarGamePresenceEgressRuntime.FallbackInput<TPresence>
    ): Promise<RallarGameSendResult> {
        const roomScopedPeerIds = uniqueSorted([
            ...input.realtime.desiredPeerIds,
            ...this.input.config.rallar.rooms.state().members
                .filter((member) => member.isOnline)
                .flatMap((member) => member.sessionIds)
        ]);
        const roomScopedPeerIdSet = new Set(roomScopedPeerIds);
        const readiness = this.input.readPeerReadiness();
        const readyPeerIds = uniqueSorted([
            ...(readiness?.laneIds.includes(input.laneId) ? readiness.readyPeerIds : []),
            ...(this.safeReadRtcStatus(input.laneId)?.readyPeerIds ?? [])
        ])
            .filter((peerId) => peerId !== this.input.readLocalPeerId())
            .filter((peerId) => roomScopedPeerIdSet.has(peerId));
        if (readyPeerIds.length === 0) {
            return input.roomResult;
        }

        const realtimeSend = await this.input.config.rallar.realtime.sendJson({
            laneId: input.laneId,
            roomId: input.room.roomRef ? undefined : input.room.roomId,
            roomRef: input.room.roomRef,
            peerIds: readyPeerIds,
            data: input.envelope,
            key: input.key,
            maxAgeMs: input.maxAgeMs,
            openTimeoutMs: input.openTimeoutMs
        });
        const realtimeResult = toRallarGameRealtimeSendResult(realtimeSend);
        return realtimeResult.status === 'sent' || realtimeResult.status === 'partial'
            ? realtimeResult
            : input.roomResult;
    }

    private safeReadRtcStatus(laneId: string): RallarRtcStatus | undefined {
        try {
            return this.input.config.rallar.rtc.status({ laneId });
        }
        catch {
            return undefined;
        }
    }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
