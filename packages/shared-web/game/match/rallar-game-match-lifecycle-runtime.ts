import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar.ts';
import type { RallarGameDirectorRelayRuntime } from '../director/rallar-game-director-relay-runtime.ts';
import type { RallarGameHostElectionRuntime } from '../director/rallar-game-host-election-runtime.ts';
import type { RallarGameLaneIds } from '../transport/lanes.ts';
import type { RallarGameMatchConfig, RallarGameTypeIds } from './rallar-game-match-contracts.ts';
import { toRallarGameReliableEgressState } from './rallar-game-match-egress-runtime.ts';
import type { RallarGameMatchRoutingRuntime } from './rallar-game-match-routing-runtime.ts';
import type { RallarGameMatchStatusRuntime } from './rallar-game-match-status-runtime.ts';
import type { RallarGameMatchStatus } from './rallar-game-match-status.ts';

export namespace RallarGameMatchLifecycleRuntime {
    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly laneIds: RallarGameLaneIds;
        readonly typeIds: RallarGameTypeIds;
        readonly status: RallarGameMatchStatusRuntime;
        readonly routing: RallarGameMatchRoutingRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly election: RallarGameHostElectionRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly directorRelay: RallarGameDirectorRelayRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readRoomTarget(): RallarGameMatchStatusRuntime.RoomTarget;
    }
}

/** Owns match subscriptions and exactly-once start/stop cleanup. */
export class RallarGameMatchLifecycleRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameMatchLifecycleRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private subscriptions: RallarSubscriptionScope | undefined;

    constructor(
        input: RallarGameMatchLifecycleRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    async start(): Promise<RallarGameMatchStatus> {
        if (!this.input.status.begin()) {
            return this.input.status.current;
        }

        this.input.routing.resetSequences();
        this.subscriptions = this.input.config.rallar.subscriptions();
        this.input.directorRelay.start();
        this.subscriptions
            .add(this.input.config.rallar.rooms.onChange(() => this.input.status.refresh()))
            .add(this.input.config.rallar.people.onChange(() => this.input.status.refresh()))
            .add(this.input.config.rallar.director.onStatus((status) => this.input.status.refresh(status)))
            .add(this.input.config.rallar.rtc.onStatus(() => this.input.status.refresh()))
            .add(this.input.config.rallar.messages.ws.onMessage<RallarMessagePayload>(
                { topicId: this.input.config.topicId, typeId: this.input.typeIds.capability },
                async (message) => await this.input.election.handleCapabilityMessage(message)
            ))
            .add(this.input.config.rallar.realtime.onJson<RallarMessagePayload>(
                this.input.laneIds.input,
                async (message) => await this.input.routing.handleRealtimeInputOrPresence(message)
            ))
            .add(this.input.config.rallar.realtime.onJson<RallarMessagePayload>(
                this.input.laneIds.snapshot,
                async (message) => await this.input.routing.handleRealtimeSnapshot(message)
            ));

        await this.refreshReliableEgress();
        return this.input.status.current;
    }

    stop(): void {
        if (!this.input.status.stop()) {
            return;
        }

        this.subscriptions?.unsubscribe();
        this.subscriptions = undefined;
        this.input.directorRelay.stop();
    }

    private async refreshReliableEgress(): Promise<void> {
        const room = this.input.readRoomTarget();
        if (!room.roomId) {
            this.input.status.setReliableEgress('empty');
            return;
        }

        try {
            const presence = await this.input.config.rallar.rooms.waitForPresence(
                room.roomRef ?? room.roomId,
                {
                    expect: { min: 1 },
                    timeoutMs: 0
                }
            );
            this.input.status.setReliableEgress(
                toRallarGameReliableEgressState(presence.status)
            );
        }
        catch {
            this.input.status.setReliableEgress('failed');
        }
    }
}
