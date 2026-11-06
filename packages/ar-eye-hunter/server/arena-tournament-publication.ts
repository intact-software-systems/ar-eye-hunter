import { readTournamentSignal } from '@shared-server/rallar-system/tournaments/tournament-signal.ts';
import type { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { ThrottledFlush } from '@shared/resilience/timing/throttled-flush.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { ArenaTournamentSnapshot } from '../arena-tournament-snapshot.ts';
import {
    ARENA_TOURNAMENT_SNAPSHOT_SENDER,
    ARENA_TOURNAMENT_SNAPSHOT_TOPIC,
    arenaTournamentFrameRoute,
    encodeArenaTournamentFrame
} from '../arena-tournament-stream.ts';
import { ARENA_TOURNAMENT_FINISH_TOPIC } from './arena-tournament-deadline.ts';

export namespace ArenaTournamentPublication {
    export interface Dependencies {
        readonly timers: Timers;
        readonly read: (ref: GroupRef) => Promise<ArenaTournamentSnapshot | null>;
        readonly send: (snapshot: ArenaTournamentSnapshot) => Promise<void>;
    }

    export interface Lane {
        readonly flush: ThrottledFlush;
        latest: Promise<void> | undefined;
        terminal: 'finished' | 'cancelled' | null;
    }

    export type Refusal = 'stopped' | 'lane-capacity';
}

/** Concurrent attempt lanes one server process publishes; a further attempt waits for its next checkpoint or reminder. */
export const ARENA_TOURNAMENT_PUBLICATION_MAX_LANES = 64;

/** One in-flight read/encode/send and one pending mark per active attempt. Only attempt identities are queued. */
export class ArenaTournamentPublication {
    private readonly lanes = new Map<string, ArenaTournamentPublication.Lane>();
    private readonly dependencies: ArenaTournamentPublication.Dependencies;
    private stopped = false;

    constructor(dependencies: ArenaTournamentPublication.Dependencies) {
        this.dependencies = dependencies;
    }

    /** A refused live offer is dropped: the attempt's next committed checkpoint offers again. */
    offer(binding: TournamentMatchBinding): ArenaTournamentPublication.Refusal | null {
        return this.markAttempt(binding, null).left ?? null;
    }

    /** The durable signal is acknowledged only after its current terminal frame reached the live publication transport. */
    async terminal(binding: TournamentMatchBinding, status: 'finished' | 'cancelled'): Promise<void> {
        const marked = this.markAttempt(binding, status);
        if (marked.right === undefined) {
            throw new Error(`Arena terminal publication refused: ${marked.left}`);
        }
        await marked.right;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.all([...this.lanes.values()].map((lane) => lane.flush.stop()));
    }

    private markAttempt(
        binding: TournamentMatchBinding,
        status: ArenaTournamentPublication.Lane['terminal']
    ): Either<ArenaTournamentPublication.Refusal, Promise<void>> {
        if (this.stopped) {
            return Either.ofLeft('stopped');
        }
        const key = JSON.stringify([
            binding.roomRef.applicationId,
            binding.roomRef.workspaceId,
            binding.roomRef.groupId,
            binding.attemptId
        ]);
        let lane = this.lanes.get(key);
        if (!lane) {
            if (this.lanes.size >= ARENA_TOURNAMENT_PUBLICATION_MAX_LANES) {
                return Either.ofLeft('lane-capacity');
            }
            lane = this.createLane(binding);
            this.lanes.set(key, lane);
        }
        if (status !== null) {
            lane.terminal = status;
        }
        const pending = lane.flush.mark(status !== null);
        if (lane.latest !== pending) {
            lane.latest = pending;
            const release = () => {
                if (this.lanes.get(key)?.latest === pending) {
                    this.lanes.delete(key);
                }
            };
            void pending.then(release, (error) => {
                release();
                if (status === null) {
                    console.error('Arena live snapshot failed', error);
                }
            });
        }
        return Either.ofRight(pending);
    }

    private createLane(binding: TournamentMatchBinding): ArenaTournamentPublication.Lane {
        const lane: ArenaTournamentPublication.Lane = {
            latest: undefined,
            terminal: null,
            flush: new ThrottledFlush({
                timers: this.dependencies.timers,
                write: async () => {
                    const snapshot = await this.dependencies.read(binding.roomRef);
                    if (snapshot === null || !jsonEquals(snapshot.binding, binding)) {
                        return;
                    }
                    if (lane.terminal !== null && snapshot.status !== lane.terminal) {
                        throw new Error('Arena terminal reminder differs from the committed attempt status');
                    }
                    await this.dependencies.send(snapshot);
                }
            }, { firstMarkDelayMs: 200, minIntervalMs: 200 })
        };
        return lane;
    }
}

/** A terminal signal remains retryable if the cluster send succeeded but the local socket write failed. */
export async function publishArenaTournamentSnapshot(
    ws: Pick<RallarServerWsRouter, 'publish'>,
    snapshot: ArenaTournamentSnapshot
): Promise<void> {
    const frame = await encodeArenaTournamentFrame(snapshot);
    const message = newALBroadcastMessage(
        ARENA_TOURNAMENT_SNAPSHOT_SENDER,
        arenaTournamentFrameRoute(snapshot.binding),
        'room',
        ARENA_TOURNAMENT_SNAPSHOT_TOPIC,
        frame,
        { groupRef: snapshot.binding.roomRef, ttlMs: 5000 }
    );
    const receipt = await ws.publish({ message, producerId: ARENA_TOURNAMENT_SNAPSHOT_SENDER, fanout: 'live-only' });
    if (receipt.reason !== undefined || !['cluster-published', 'sent-live', 'no-recipients'].includes(receipt.status)) {
        throw new Error(`Arena snapshot publication ${receipt.status}: ${receipt.reason ?? 'no live delivery'}`);
    }
}

export interface InstallArenaTournamentFinishPublicationInput {
    readonly outbox: OutboxQueueReader;
    readonly publication: ArenaTournamentPublication;
    readonly nowEpochMs: () => number;
}

/** A restarted publisher consumes the immutable finish reminder committed alongside the final checkpoint. */
export function installArenaTournamentFinishPublication(
    { outbox, publication, nowEpochMs }: InstallArenaTournamentFinishPublicationInput
): void {
    outbox.onOutboxMessageDo(ARENA_TOURNAMENT_FINISH_TOPIC, {
        onMessage: async (message) => {
            const signal = readTournamentSignal(message, ARENA_TOURNAMENT_FINISH_TOPIC, nowEpochMs());
            if (signal.kind !== 'result') {
                throw new TypeError('Arena finish signal requires an exact result binding');
            }
            await publication.terminal(signal.binding, 'finished');
        }
    }, [ARENA_TOURNAMENT_FINISH_TOPIC]);
}
