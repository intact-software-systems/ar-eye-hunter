import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import type { RallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';

import type { PracticeInput } from '../practice-rules.ts';
import type { TownMatchAction } from './match-protocol.ts';
import { TownMatchLivePoses } from './realtime/town-match-live-poses.ts';
import { TownMatchTransport } from './realtime/town-match-transport.ts';
import { TownMatchRoom } from './town-match-room.ts';
import type { TownMatchState } from './town-match.ts';

import { TownMatchExchange } from './agreement/town-match-exchange.ts';
import { TownMatchConnection } from './realtime/town-match-connection.ts';
import { TownMatchFrames } from './realtime/town-match-frames.ts';
import { TownMatchRound } from './town-match-round.ts';

export namespace TownMatchSession {
    export type Intent =
        | Exclude<TownMatchAction, { readonly kind: 'ready'; }>
        | { readonly kind: 'ready'; readonly ready: boolean; };
    export interface Dependencies {
        readonly browser: Pick<
            RallarFacade,
            | 'compareDeadline'
            | 'deadlineAfter'
            | 'director'
            | 'messages'
            | 'realtime'
            | 'rooms'
            | 'session'
            | 'isConnected'
            | 'ws'
        >;
        readonly timers: Timers;
        readonly subtle: Pick<SubtleCrypto, 'digest'>;
        readonly newMatchId: () => string;
    }
    export interface View {
        readonly match: TownMatchState | undefined;
        readonly localId: string | undefined;
        readonly isDirector: boolean;
        readonly available: boolean;
        readonly recovering: boolean;
        readonly observing: boolean;
        readonly interruption: string | undefined;
        readonly inputGeneration: number;
        readonly error: string;
        readonly appointmentEligibility: RallarGroupDirectorAppointmentEligibility;
        readonly appointing: boolean;
        readonly livePoses: TownMatchLivePoses.Sample | undefined;
        readonly liveSend: ReturnType<TownMatchTransport['getLiveSend']>;
        /** Carrier of the last authenticated control frame received by this host, not an acknowledgement. */
        readonly inputTransport: 'rtc' | 'ws' | 'none';
    }
}

/** One room's authenticated match transport, director simulation and committed presentation state. */
export class TownMatchSession {
    private readonly subscriptions = new SubscriptionScope();
    private readonly changes = new SynchronousNotifications<void>((error) =>
        console.error('Match listener failed', error)
    );
    private readonly lifetime = new AbortController();
    private readonly transport: TownMatchTransport;
    private readonly room: TownMatchRoom;
    private readonly round: TownMatchRound;
    private readonly connection: TownMatchConnection;
    private readonly frames: TownMatchFrames;
    private readonly exchange: TownMatchExchange;
    private lastInput = 0;
    private lastExchange = 0;
    private readonly dependencies: TownMatchSession.Dependencies;
    readonly roomRef: GroupRef;

    constructor(dependencies: TownMatchSession.Dependencies, roomRef: GroupRef) {
        this.dependencies = dependencies;
        this.roomRef = roomRef;
        this.transport = new TownMatchTransport({
            reliable: dependencies.browser.messages.room<string>({
                roomRef,
                topicId: 'app.cca.match',
                typeId: 'cca.match.frame',
                purpose: 'notification',
                access: 'members'
            }),
            realtime: dependencies.browser.realtime.room<string>({ roomRef, waitForReady: false })
        });
        this.room = new TownMatchRoom(dependencies, roomRef);
        const signal = this.lifetime.signal;
        this.round = new TownMatchRound(dependencies, this.room, signal);
        this.connection = new TownMatchConnection(
            dependencies,
            this.room,
            this.round,
            this.transport,
            signal,
            this.changes
        );
        this.frames = new TownMatchFrames(
            dependencies,
            roomRef,
            this.round,
            this.connection,
            this.transport,
            signal,
            this.changes
        );
        this.exchange = new TownMatchExchange(dependencies, this.round, this.connection, this.frames);
    }

    start(): void {
        this.transport.start((reception) => this.frames.receive(reception));
        this.subscriptions.add(this.dependencies.browser.ws.onLifecycle((event) => {
            if (event.kind === 'close' || event.kind === 'disconnected') {
                this.round.interruptTransport();
                this.changes.publishLatest(undefined);
            }
        }, { emitCurrent: false }));
        this.subscriptions.add(startRepeating({
            timers: this.dependencies.timers,
            intervalMs: 16,
            firstRun: 'after-interval',
            run: () => this.advance()
        }));
    }

    onChange(listener: () => void): () => void {
        return this.changes.subscribeAndNotify(listener, undefined).unsubscribe;
    }

    getView(): TownMatchSession.View {
        return this.connection.getView();
    }

    appoint(): Promise<void> {
        return this.connection.appoint();
    }

    act(action: TownMatchSession.Intent): Promise<void> {
        return this.exchange.act(action);
    }

    setControls(controls: PracticeInput): void {
        this.round.controls = controls;
    }

    stop(): void {
        if (this.lifetime.signal.aborted) {
            return;
        }
        this.lifetime.abort();
        this.round.generation += 1;
        this.subscriptions.unsubscribe();
        this.room.stop();
        this.transport.stop();
        this.round.livePoses.clear();
        this.round.simulation?.stop();
    }

    private async advance(): Promise<void> {
        try {
            this.connection.reconcileAuthority();
            await this.connection.recoverConnection();
            if (this.lifetime.signal.aborted) {
                return;
            }
            if (!this.connection.getView().available || !this.round.checkpoints) {
                this.round.simulation?.pause(this.dependencies.timers.nowMs());
                this.round.controls = { x: 0, z: 0, dash: this.round.controls.dash };
                this.changes.publishLatest(undefined);
                return;
            }
            const now = this.dependencies.timers.nowMs();
            const view = this.connection.getView();
            if (view.recovering) {
                this.round.simulation?.pause(now);
                this.round.controls = { x: 0, z: 0, dash: this.round.controls.dash };
            }
            else if (view.isDirector) {
                this.round.simulation?.advance(
                    now,
                    this.round.checkpoints.getState().committed?.state,
                    this.dependencies.browser
                );
            }
            const match = this.round.checkpoints.getState().committed?.state;
            if (match?.phase === 'playing' && now - this.lastInput >= 50) {
                this.lastInput = now;
                await this.act({ kind: 'controls', ...this.round.controls });
                if (view.isDirector && !view.recovering) {
                    await this.exchange.publishLivePoses();
                }
            }
            const checkpoint = this.round.checkpoints.getState();
            const settledLobby = match?.phase === 'lobby' && !checkpoint.pending && !checkpoint.recoveryRequired &&
                !this.round.intent && (!view.isDirector || this.round.simulation?.getState() === match);
            // A quiet lobby still retransmits for a peer that missed commitment.
            // New rosters, commands and unsettled checkpoints use the normal exchange interval.
            if (now - this.lastExchange >= (settledLobby ? 1000 : 100)) {
                this.lastExchange = now;
                await this.exchange.exchangeCheckpoints(view.recovering);
            }
            this.changes.publishLatest(undefined);
        }
        catch (error) {
            this.connection.report(error instanceof Error ? error.message : 'The match connection failed.');
        }
    }
}
