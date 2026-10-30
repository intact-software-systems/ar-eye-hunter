import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupRef, type GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeGroupMove } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove, GroupMoveAction, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { readApiBaseUrl } from '../../api-client-config.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '../../api/send-api-http-request.ts';
import { toStateScopeHttpPath } from '../../api/state-http-path.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { RallarWsMessageLane } from '../../messages/rallar-message-operations.ts';
import type { RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import type { BrowserRallarRooms } from '../browser-rallar-rooms.ts';

export namespace RallarRoomMove {
    export interface State {
        readonly moves: readonly GroupMove[];
        readonly busy: boolean;
        readonly enteringMoveId: string | null;
        readonly error: string | null;
    }
    export interface Auth extends Pick<RallarAuthFacade, 'onChange'> {
        session(): AuthSession | undefined;
    }
    export interface Api {
        list(scope: StateScope, session: AuthSession, signal: AbortSignal): Promise<readonly GroupMove[]>;
        mutate(request: GroupMoveRequest, session: AuthSession, signal: AbortSignal): Promise<GroupMove>;
    }
    export interface Dependencies {
        readonly auth: Auth;
        readonly api: Api;
        readonly timers: Timers;
        currentRoom(): GroupRef | undefined;
        activate(move: GroupMove, signal: AbortSignal): Promise<void>;
        refreshRooms(move: GroupMove, signal: AbortSignal): Promise<void>;
        onChanged(listener: () => void): RallarUnsubscribe;
        /** The game owns its participation lock and fresh eligibility check around the operation. */
        withEligibility<T>(destination: GroupRef, run: () => Promise<T>): Promise<T>;
    }
    export interface Browser {
        readonly auth: Pick<RallarAuthFacade, 'onChange'>;
        readonly rooms: Pick<BrowserRallarRooms, 'state' | 'activateMove' | 'session'>;
        readonly messages: Readonly<{ ws: Pick<RallarWsMessageLane, 'onMessage'>; }>;
        session(): AuthSession | undefined;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly refreshIntervalMs: number;
    }
    export interface Attempt {
        readonly generation: number;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
}

/** Owns session-bound consent and durable recovery. Messages only wake an authenticated read. */
export class RallarRoomMove {
    private readonly dependencies: RallarRoomMove.Dependencies;
    private readonly config: RallarRoomMove.Config;
    private readonly notifications = new SynchronousNotifications<RallarRoomMove.State>((error) => {
        console.error('Error notifying room move listener', error);
    });
    private readonly reads = new SingleFlight<number, void>();
    private readonly attemptedEntries = new Set<string>();
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private generation = 0;
    private revision = 0;
    private refreshRequested = 0;
    private sessionKey: string | null = null;
    private state: RallarRoomMove.State = { moves: [], busy: false, enteringMoveId: null, error: null };

    public static createBrowser(
        browser: RallarRoomMove.Browser,
        withEligibility: RallarRoomMove.Dependencies['withEligibility'],
        config: RallarRoomMove.Config
    ): RallarRoomMove {
        return new RallarRoomMove({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: { list: listMoves, mutate: mutateMove },
            timers: createDefaultTimers(),
            currentRoom: () => browser.rooms.state().currentRoomRef,
            activate: async (move, signal) => {
                await browser.rooms.activateMove(move, { signal, timeoutMs: 15000, maxAttempts: 2 });
            },
            refreshRooms: async (move, signal) => {
                await browser.rooms.session(move.source).refresh({ signal, timeoutMs: 10000 });
                await browser.rooms.session(move.destination).refresh({ signal, timeoutMs: 10000 });
            },
            onChanged: (listener) =>
                browser.messages.ws.onMessage({
                    topicId: AppTopics.groupMoveChanged,
                    typeId: AppTopics.groupMoveChanged
                }, listener),
            withEligibility
        }, config);
    }

    public constructor(dependencies: RallarRoomMove.Dependencies, config: RallarRoomMove.Config) {
        if (!Number.isSafeInteger(config.refreshIntervalMs) || config.refreshIntervalMs <= 0) {
            throw new TypeError('Move refresh interval must be a positive integer');
        }
        this.dependencies = dependencies;
        this.config = config;
    }

    public getState(): RallarRoomMove.State {
        return this.state;
    }

    public onChange(listener: (state: RallarRoomMove.State) => void): RallarUnsubscribe {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }

    public start(): Promise<void> {
        if (!this.subscriptions) {
            this.subscriptions = new SubscriptionScope();
            this.sessionKey = this.authKey();
            this.subscriptions.add(
                this.dependencies.auth.onChange(() => this.authenticationChanged(), { emitCurrent: false })
            );
            this.subscriptions.add(this.dependencies.onChanged(() => {
                void this.refresh();
            }));
            this.subscriptions.add(
                startRepeating({
                    timers: this.dependencies.timers,
                    intervalMs: this.config.refreshIntervalMs,
                    firstRun: 'after-interval',
                    run: () => this.refresh()
                })
            );
        }
        return this.refresh();
    }

    public stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        subscriptions?.unsubscribe();
        this.invalidate();
        this.publish({ moves: [], busy: false, enteringMoveId: null, error: null });
    }

    public refresh(): Promise<void> {
        this.refreshRequested++;
        const generation = this.generation;
        return this.reads.run(generation, async () => {
            while (this.generation === generation && this.subscriptions !== null) {
                const requested = this.refreshRequested;
                await this.readMoves();
                if (requested === this.refreshRequested) {
                    return;
                }
            }
        });
    }

    public async propose(destination: GroupRef): Promise<void> {
        const source = this.dependencies.currentRoom();
        if (!source) {
            this.publish({ ...this.state, error: 'Enter a source room first.' });
            return;
        }
        await this.send({
            requestId: crypto.randomUUID(),
            moveId: crypto.randomUUID(),
            source: toCanonicalGroupRef(source),
            destination: toCanonicalGroupRef(destination),
            action: 'propose',
            joinCode: null,
            inviteToken: null
        });
    }

    public async act(
        action: Exclude<GroupMoveAction, 'propose' | 'arrive'>,
        move: GroupMove,
        joinCode: string | null = null,
        inviteToken: string | null = null
    ): Promise<void> {
        await this.send({
            requestId: crypto.randomUUID(),
            moveId: move.moveId,
            source: move.source,
            destination: move.destination,
            action,
            joinCode,
            inviteToken
        });
    }

    public async enter(move: GroupMove): Promise<void> {
        if (this.state.busy) {
            return;
        }
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        this.attemptedEntries.add(groupMoveKey(move));
        this.publish({ ...this.state, busy: true, enteringMoveId: move.moveId, error: null });
        try {
            this.assertMove(move, attempt);
            await this.dependencies.withEligibility(move.destination, async () => {
                this.assertCurrent(attempt);
                await this.dependencies.activate(move, attempt.signal);
                this.assertCurrent(attempt);
            });
            // A new login may enter its admitted membership, but cannot claim the old session arrived.
            if (
                move.participants.some((participant) =>
                    participant.sessionId === attempt.session.sessionId &&
                    participant.principalId === attempt.session.clientId
                )
            ) {
                const result = await this.dependencies.api.mutate(
                    {
                        requestId: crypto.randomUUID(),
                        moveId: move.moveId,
                        source: move.source,
                        destination: move.destination,
                        action: 'arrive',
                        joinCode: null,
                        inviteToken: null
                    },
                    attempt.session,
                    attempt.signal
                );
                this.assertCurrent(attempt);
                this.accept(result, attempt);
                await this.dependencies.refreshRooms(result, attempt.signal);
                this.assertCurrent(attempt);
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.publish({ ...this.state, error: toError(error).message });
            }
        }
        finally {
            if (this.current(attempt)) {
                this.publish({ ...this.state, busy: false, enteringMoveId: null });
            }
        }
    }

    private async readMoves(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        const revision = this.revision;
        try {
            const moves = await this.dependencies.api.list(this.config.scope, attempt.session, attempt.signal);
            if (!this.current(attempt) || revision !== this.revision) {
                return;
            }
            for (const move of moves) {
                this.assertMove(move, attempt);
            }
            const previousMoves = this.state.moves;
            // The durable decision must remain usable even if a historical room is now unreadable.
            this.publish({ ...this.state, moves });
            await this.enterCurrentSourceMove();
            const currentRoom = this.dependencies.currentRoom();
            for (const move of moves) {
                const previous = previousMoves.find((candidate) =>
                    candidate.moveId === move.moveId && isSameGroupRef(candidate.source, move.source)
                );
                if (
                    currentRoom &&
                    (isSameGroupRef(currentRoom, move.source) || isSameGroupRef(currentRoom, move.destination)) &&
                    move.status === 'committed' && move.participants.some((participant) =>
                        participant.arrivedAtEpochMs !== null
                    ) &&
                    JSON.stringify(move) !== JSON.stringify(previous)
                ) {
                    await this.dependencies.refreshRooms(move, attempt.signal);
                    this.assertCurrent(attempt);
                }
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.publish({ ...this.state, error: toError(error).message });
            }
        }
    }

    private async send(request: GroupMoveRequest): Promise<void> {
        if (this.state.busy) {
            return;
        }
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        this.revision++;
        this.publish({ ...this.state, busy: true, error: null });
        try {
            const send = async () => {
                this.assertCurrent(attempt);
                const result = await this.dependencies.api.mutate(request, attempt.session, attempt.signal);
                this.assertCurrent(attempt);
                if (
                    result.moveId !== request.moveId || !isSameGroupRef(result.source, request.source) ||
                    !isSameGroupRef(result.destination, request.destination)
                ) {
                    throw new TypeError('Room move response identity differs');
                }
                this.accept(result, attempt);
            };
            if (request.action === 'propose' || request.action === 'confirm' || request.action === 'commit') {
                await this.dependencies.withEligibility(request.destination, send);
            }
            else {
                await send();
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.publish({ ...this.state, error: toError(error).message });
            }
        }
        finally {
            if (this.current(attempt)) {
                this.publish({ ...this.state, busy: false });
            }
        }
        if (this.current(attempt)) {
            await this.enterCurrentSourceMove();
            await this.refresh(); // Also resolves a response lost after the server committed.
        }
    }

    private accept(move: GroupMove, attempt: RallarRoomMove.Attempt): void {
        this.assertMove(move, attempt);
        this.revision++;
        this.publish({
            ...this.state,
            moves: [
                move,
                ...this.state.moves.filter((current) =>
                    !isSameGroupRef(current.source, move.source) || current.moveId !== move.moveId
                )
            ]
        });
    }

    private async enterCurrentSourceMove(): Promise<void> {
        const current = this.dependencies.currentRoom();
        const session = this.dependencies.auth.session();
        const move = this.state.moves.find((candidate) =>
            candidate.status === 'committed' && current &&
            isSameGroupRef(current, candidate.source) && !this.attemptedEntries.has(groupMoveKey(candidate)) &&
            candidate.participants.some((participant) =>
                participant.sessionId === session?.sessionId && participant.arrivedAtEpochMs === null
            )
        );
        if (move) {
            await this.enter(move);
        }
    }

    private assertMove(move: GroupMove, attempt: RallarRoomMove.Attempt): void {
        decodeGroupMove(move);
        if (
            move.source.applicationId !== this.config.scope.applicationId ||
            move.source.workspaceId !== this.config.scope.workspaceId ||
            !move.participants.some((participant) => participant.principalId === attempt.session.clientId)
        ) {
            throw new TypeError('Room move does not belong to this scope and account');
        }
    }

    private attempt(): RallarRoomMove.Attempt | null {
        const session = this.dependencies.auth.session();
        return this.subscriptions && session
            ? { generation: this.generation, session, signal: this.controller.signal }
            : null;
    }

    private current(attempt: RallarRoomMove.Attempt): boolean {
        return this.subscriptions !== null && !attempt.signal.aborted && this.generation === attempt.generation &&
            this.authKey() === toAuthSessionKey(attempt.session);
    }

    private assertCurrent(attempt: RallarRoomMove.Attempt): void {
        if (!this.current(attempt)) {
            throw new DOMException('Room move belongs to an obsolete session', 'AbortError');
        }
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session ? toAuthSessionKey(session) : null;
    }

    private authenticationChanged(): void {
        const key = this.authKey();
        if (key === this.sessionKey) {
            return;
        }
        this.sessionKey = key;
        this.invalidate();
        this.publish({ moves: [], busy: false, enteringMoveId: null, error: null });
        void this.refresh();
    }

    private invalidate(): void {
        this.generation++;
        this.controller.abort();
        this.controller = new AbortController();
        this.reads.clear();
        this.attemptedEntries.clear();
    }

    private publish(state: RallarRoomMove.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}

async function listMoves(scope: StateScope, session: AuthSession, signal: AbortSignal): Promise<readonly GroupMove[]> {
    const value = await sendApiHttpRequest<never, unknown>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/group-moves`,
        method: 'GET',
        body: undefined,
        options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }
    });
    if (!Array.isArray(value)) {
        throw new TypeError('Room move list must be an array');
    }
    return Array.from(value, decodeGroupMove);
}

async function mutateMove(request: GroupMoveRequest, session: AuthSession, signal: AbortSignal): Promise<GroupMove> {
    return await new Command(async (attemptSignal) => {
        const options: ApiMutationRequestOptions = {
            authSession: session,
            signal: attemptSignal,
            requestId: request.requestId
        };
        const value = await sendApiHttpRequest<GroupMoveRequest, unknown>({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(`${toStateScopeHttpPath(request.source)}/group-moves`, request.requestId),
            method: 'POST',
            body: request,
            options
        });
        return decodeGroupMove(value);
    }, { signal, timeoutMs: 15000, maxAttempts: 2 }).run();
}

function groupMoveKey(move: GroupMove): string {
    return JSON.stringify([move.source.applicationId, move.source.workspaceId, move.source.groupId, move.moveId]);
}
