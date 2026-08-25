import type { RallarRtcRoomLaneWaitResult, RallarRtcRoomLaneWaitStatus } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameFreshDirectorStatus } from '../director/rallar-game-fresh-director-status.ts';
import type { RallarGameEnvelope, RallarGameEnvelopeKind } from '../envelopes.ts';
import type { RallarGameLaneIds } from '../transport/lanes.ts';
import type { RallarGameSendResult } from '../transport/rallar-game-send-result.ts';
import {
    toRallarGameRealtimeSendResult,
    toRallarGameRoomRealtimeSendResult
} from '../transport/to-rallar-game-realtime-send-result.ts';
import type { RallarGameEnvelopeHandler, RallarGameMatchConfig } from './rallar-game-match-contracts.ts';
import type { RallarGameLaneReadyOptions, RallarGamePeerReadiness } from './rallar-game-match-egress-contracts.ts';
import type { RallarGameEgressState } from './rallar-game-match-status.ts';

export namespace RallarGameMatchEgressRuntime {
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
        readRoomTarget(): RoomTarget;
        readFreshDirectorStatus(): RallarGameFreshDirectorStatus | undefined;
        createEnvelope<T>(
            kind: RallarGameEnvelopeKind,
            payload: T,
            options: EnvelopeOptions
        ): RallarGameEnvelope<T>;
        routeEnvelope<T>(
            envelope: RallarGameEnvelope<T>,
            kind: RallarGameEnvelopeKind,
            handler: RallarGameEnvelopeHandler<T> | undefined
        ): Promise<void>;
        sendReliableSnapshot(envelope: RallarGameEnvelope<TSnapshot>): Promise<RallarGameSendResult>;
        refreshStatus(): void;
    }
}

interface RallarGameLaneReadinessInput {
    readonly roomId: string;
    readonly roomTarget: string | GroupRef;
    readonly laneIds: readonly string[];
    readonly options: RallarGameLaneReadyOptions;
}

interface RallarGameSnapshotPublishOptions {
    readonly reliable?: boolean;
}

/** Owns match lane readiness and realtime outbound transport selection. */
export class RallarGameMatchEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameMatchEgressRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private lastReadiness: RallarGamePeerReadiness | undefined;
    private realtimeEgress: RallarGameEgressState = 'empty';

    constructor(
        input: RallarGameMatchEgressRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    get peerReadiness(): RallarGamePeerReadiness | undefined {
        return this.lastReadiness;
    }

    get realtimeState(): RallarGameEgressState {
        return this.realtimeEgress;
    }

    async waitForReadyLanes(
        options: RallarGameLaneReadyOptions = {}
    ): Promise<RallarGamePeerReadiness> {
        const selectedLaneIds = options.laneIds ?? Object.values(this.input.laneIds);
        if (this.input.isStopped()) {
            return this.recordReadiness({
                ...emptyPeerReadiness(selectedLaneIds),
                status: 'aborted',
                reason: 'Rallar Game match is stopped.'
            });
        }

        const room = this.input.readRoomTarget();
        if (!room.roomId) {
            return this.recordReadiness({
                ...emptyPeerReadiness(selectedLaneIds),
                status: 'no-room',
                reason: 'Cannot wait for lanes without a room.'
            });
        }

        const readiness = await this.readLaneReadiness({
            roomId: room.roomId,
            roomTarget: room.roomRef ?? room.roomId,
            laneIds: selectedLaneIds,
            options
        });
        return this.recordReadiness(readiness);
    }

    private async readLaneReadiness(
        input: RallarGameLaneReadinessInput
    ): Promise<RallarGamePeerReadiness> {
        const lanes = await Promise.all(
            input.laneIds.map((laneId) =>
                this.input.config.rallar.rtc.waitForRoomLane(
                    input.roomTarget,
                    laneId,
                    {
                        connect: input.options.connect ?? true,
                        timeoutMs: input.options.timeoutMs,
                        signal: input.options.signal,
                        expect: input.options.expect
                    }
                )
            )
        );
        const readyPeerIds = uniqueSorted(
            lanes.flatMap((lane) =>
                lane.readyPeerIds.length > 0
                    ? lane.readyPeerIds
                    : lane.ready.map((entry) => entry.peerId)
            )
        );
        const expectedCounts = lanes
            .map((lane) => lane.expectedCount)
            .filter((count): count is number => count !== undefined);

        return {
            status: combineLaneStatuses(lanes),
            roomId: input.roomId,
            laneIds: input.laneIds,
            readyPeerIds,
            notReadyPeerIds: uniqueSorted(
                lanes.flatMap((lane) =>
                    lane.notReadyPeerIds.length > 0
                        ? lane.notReadyPeerIds
                        : lane.notReady.map((entry) => entry.peerId)
                )
            ),
            missingPeerIds: uniqueSorted(lanes.flatMap((lane) => lane.missingPeerIds)),
            extraPeerIds: uniqueSorted(lanes.flatMap((lane) => lane.extraPeerIds)),
            observedCount: readyPeerIds.length,
            expectedCount: expectedCounts.length > 0 ? Math.max(...expectedCounts) : undefined,
            lanes
        };
    }

    async sendInput(input: TInput): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return stoppedResult();
        }

        const director = this.input.readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const envelope = this.input.createEnvelope('input', input, {
            directorEpoch: director.appointment.epoch
        });
        if (director.isDirector) {
            await this.input.routeEnvelope(envelope, 'input', this.input.config.onInput);
            return { status: 'sent', transport: 'local' };
        }

        return toRallarGameRealtimeSendResult(
            await this.input.config.rallar.realtime.sendJson({
                laneId: this.input.laneIds.input,
                peerIds: [director.appointment.sessionId],
                data: envelope,
                key: `input:${envelope.senderId}`,
                maxAgeMs: 250
            })
        );
    }

    async publishSnapshot(
        snapshot: TSnapshot,
        options: RallarGameSnapshotPublishOptions = {}
    ): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return stoppedResult();
        }

        const director = this.input.readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }
        if (!director.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the fresh local director can publish snapshots.'
            };
        }

        const envelope = this.input.createEnvelope('snapshot', snapshot, {
            directorEpoch: director.appointment.epoch
        });
        if (options.reliable) {
            return await this.input.sendReliableSnapshot(envelope);
        }

        const room = this.input.readRoomTarget();
        return toRallarGameRoomRealtimeSendResult(
            await this.input.config.rallar.realtime.room({
                laneId: this.input.laneIds.snapshot,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef
            }).send(envelope, {
                key: `snapshot:${envelope.senderId}`,
                maxAgeMs: 500
            })
        );
    }

    private recordReadiness(readiness: RallarGamePeerReadiness): RallarGamePeerReadiness {
        this.lastReadiness = readiness;
        this.realtimeEgress = toRealtimeEgressState(readiness.status);
        this.input.refreshStatus();
        return readiness;
    }
}

function combineLaneStatuses(
    lanes: readonly RallarRtcRoomLaneWaitResult[]
): RallarGamePeerReadiness['status'] {
    if (lanes.length === 0) {
        return 'empty';
    }

    const statuses = lanes.map((lane) => lane.status);
    if (statuses.every((status) => status === 'open')) {
        return 'open';
    }
    if (statuses.every((status) => status === 'empty')) {
        return 'empty';
    }
    for (const status of ['failed', 'aborted', 'timeout', 'not-connected', 'over-capacity'] as const) {
        if (statuses.includes(status)) {
            return status;
        }
    }
    return statuses.some(isPartiallyReadyLaneStatus) ? 'partial' : 'not-ready';
}

function isPartiallyReadyLaneStatus(status: RallarRtcRoomLaneWaitStatus): boolean {
    return status === 'open' ||
        status === 'partial' ||
        status === 'empty' ||
        status === 'over-capacity';
}

function toRealtimeEgressState(
    status: RallarGamePeerReadiness['status']
): RallarGameEgressState {
    switch (status) {
        case 'open':
            return 'ready';
        case 'empty':
        case 'no-room':
            return 'empty';
        case 'partial':
        case 'over-capacity':
            return 'partial';
        case 'not-ready':
        case 'not-connected':
            return 'warming';
        case 'timeout':
            return 'timeout';
        case 'aborted':
        case 'failed':
            return 'failed';
    }
}

export function toRallarGameReliableEgressState(status: string): RallarGameEgressState {
    switch (status) {
        case 'ready':
            return 'ready';
        case 'partial':
        case 'over-capacity':
            return 'partial';
        case 'timeout':
            return 'timeout';
        case 'empty':
            return 'empty';
        case 'aborted':
        case 'not-connected':
        case 'not-found':
            return 'failed';
        default:
            return 'warming';
    }
}

function stoppedResult(): RallarGameSendResult {
    return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
}

function noDirectorResult(): RallarGameSendResult {
    return { status: 'no-director', reason: 'No fresh director is available.' };
}

function emptyPeerReadiness(
    laneIds: readonly string[]
): Omit<RallarGamePeerReadiness, 'status'> {
    return {
        laneIds,
        readyPeerIds: [],
        notReadyPeerIds: [],
        missingPeerIds: [],
        extraPeerIds: [],
        observedCount: 0,
        lanes: []
    };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
