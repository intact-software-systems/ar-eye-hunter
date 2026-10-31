import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { SESSION_HEARTBEAT_INTERVAL_MS } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { RallarLifecycleParticipant } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import {
    GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    type GroupTopicSubscriptionResult
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { RallarTopicSubscription } from '@shared-web/browser/messages/rallar-message-contracts.ts';

import type {
    BrowserTopicSubscriptionHttpApi,
    BrowserTopicSubscriptionRequest
} from './browser-topic-subscription-http-api.ts';
import { BrowserTopicSubscriptionToken } from './browser-topic-subscription-token.ts';
import { toTopicSubscriptionAnswer, type TopicSubscriptionAnswer } from './to-topic-subscription-answer.ts';

export namespace BrowserTopicSubscriptions {
    export interface Input {
        readonly http: BrowserTopicSubscriptionHttpApi;
        readonly timers: Timers;
        /** A subscribe, a renewal, a re-assertion and a release are each their own logical call. */
        readonly newRequestId: () => string;
    }

    export interface Hold {
        readonly roomRef: GroupRef;
        readonly topicId: string;
    }
}

interface HeldTopic {
    readonly key: string;
    readonly hold: BrowserTopicSubscriptions.Hold;
    readonly tokens: Set<BrowserTopicSubscriptionToken>;
    status: 'pending' | 'active';
    lastActiveAtMs: number | undefined;
}

interface AttachedConnection {
    readonly context: ApiMiddleware;
    readonly stopRenewing: () => void;
}

type TopicSubscriptionCall = 'subscribe' | 'unsubscribe';

const SOCKET_CALLBACK_ID = 'rallar:topic-subscriptions';

/**
 * The tab's elections to receive granted topics: tokens count per (GroupRef, topicId); the first token subscribes,
 * the last one releases, and the held keys renew on the heartbeat cadence and re-assert on every socket reopen.
 */
export class BrowserTopicSubscriptions implements RallarLifecycleParticipant {
    public readonly id = 'topic-subscriptions';
    public readonly order = 45;
    readonly #input: BrowserTopicSubscriptions.Input;
    readonly #held = new Map<string, HeldTopic>();
    /** One key's remote calls run one at a time across its holds, so no subscribe overtakes the release before it. */
    readonly #remoteCalls = new Map<string, Promise<void>>();
    #connection: AttachedConnection | undefined;
    /** A replaced tab and a session the server no longer authenticates send nothing until the next attach. */
    #remoteCallsStopped = false;

    public constructor(input: BrowserTopicSubscriptions.Input) {
        this.#input = input;
    }

    public hold(hold: BrowserTopicSubscriptions.Hold): RallarTopicSubscription {
        const key = `${toScopedGroupKey(hold.roomRef)}|${hold.topicId}`;
        const held = this.#held.get(key) ?? this.#startHolding(key, hold);
        const token = new BrowserTopicSubscriptionToken((released) => this.#release(held, released));
        held.tokens.add(token);
        token.settle(held.status);
        return token;
    }

    public attach(context: ApiMiddleware): void {
        this.#remoteCallsStopped = false;
        context.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo(SOCKET_CALLBACK_ID, {
            onOpen: () => this.#assertAll(),
            onClose: (event) => {
                if (event.code === 1000 && event.reason === 'connection-replaced') {
                    this.#stopRemoteCalls();
                }
            }
        });
        const stopRenewing = startRepeating({
            timers: this.#input.timers,
            intervalMs: SESSION_HEARTBEAT_INTERVAL_MS,
            firstRun: 'after-interval',
            run: () => this.#assertAll()
        });
        this.#connection = { context, stopRenewing };
        this.#assertAll();
    }

    /**
     * The releases are best-effort: the server drops a session's elections when it ends or its lease lapses. The
     * transport shutdown closes the socket in the same tick, so the generation is the one the open socket last named.
     */
    public detach(): void {
        const connection = this.#connection;
        if (connection === undefined) {
            return;
        }
        this.#connection = undefined;
        connection.stopRenewing();
        const { middleware } = connection.context;
        middleware.webSocketQueueBox.socket.removeWebsocketCallbackById(SOCKET_CALLBACK_ID);
        const generationId = middleware.ownWsConnectionGeneration.readKnown();
        for (const held of this.#endAll()) {
            if (generationId !== undefined) {
                void this.#queueRemoteCall(held.key, async () => {
                    await this.#send('unsubscribe', this.#toRequest(held.hold, connection, generationId));
                });
            }
        }
    }

    #startHolding(key: string, hold: BrowserTopicSubscriptions.Hold): HeldTopic {
        const held: HeldTopic = { key, hold, tokens: new Set(), status: 'pending', lastActiveAtMs: undefined };
        this.#held.set(key, held);
        this.#queueAssert(held);
        return held;
    }

    async #release(held: HeldTopic, token: BrowserTopicSubscriptionToken): Promise<void> {
        if (!held.tokens.delete(token)) {
            return;
        }
        token.settle('lapsed');
        if (held.tokens.size > 0 || this.#held.get(held.key) !== held) {
            return;
        }
        this.#held.delete(held.key);
        const connection = this.#connection;
        if (connection !== undefined) {
            await this.#queueRemoteCall(held.key, async () => await this.#unsubscribe(held, connection));
        }
    }

    #assertAll(): void {
        for (const held of this.#held.values()) {
            this.#queueAssert(held);
        }
    }

    #queueAssert(held: HeldTopic): void {
        const connection = this.#connection;
        if (connection !== undefined && !this.#remoteCallsStopped) {
            void this.#queueRemoteCall(held.key, async () => await this.#assert(held, connection));
        }
    }

    /** A failed call is logged and the key's later calls still run. */
    #queueRemoteCall(key: string, run: () => Promise<void>): Promise<void> {
        const call = (this.#remoteCalls.get(key) ?? Promise.resolve())
            .then(run)
            .catch((error: Error) => console.warn(`Topic subscription call for ${key} failed:`, error));
        this.#remoteCalls.set(key, call);
        void call.then(() => this.#forgetSettledCall(key, call));
        return call;
    }

    #forgetSettledCall(key: string, call: Promise<void>): void {
        if (this.#remoteCalls.get(key) === call) {
            this.#remoteCalls.delete(key);
        }
    }

    async #assert(held: HeldTopic, connection: AttachedConnection): Promise<void> {
        if (!this.#isCurrent(held, connection)) {
            return;
        }
        const first = await this.#subscribe(held, connection);
        const answer = first === 'stale-generation' && this.#isCurrent(held, connection)
            ? await this.#subscribe(held, connection)
            : first;
        if (!this.#isCurrent(held, connection)) {
            return;
        }
        if (answer === 'unauthorized') {
            this.#stopRemoteCalls();
            return;
        }
        this.#applyAnswer(held, answer);
    }

    #applyAnswer(held: HeldTopic, answer: Exclude<TopicSubscriptionAnswer, 'unauthorized'>): void {
        const nowMs = this.#input.timers.nowMs();
        if (answer === 'active') {
            held.status = 'active';
            held.lastActiveAtMs = nowMs;
            for (const token of held.tokens) {
                token.settle('active');
            }
        }
        else if (answer === 'refused' || answer === 'stale-generation') {
            this.#end(held, 'refused');
        }
        else if (
            held.lastActiveAtMs !== undefined && nowMs >= held.lastActiveAtMs + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS
        ) {
            this.#end(held, 'lapsed');
        }
    }

    /** `unchanged` while the socket's generation cannot be read: the next tick or reopen asserts again. */
    async #subscribe(held: HeldTopic, connection: AttachedConnection): Promise<TopicSubscriptionAnswer> {
        const generation = await connection.context.middleware.ownWsConnectionGeneration.read();
        if (generation.right === undefined) {
            return 'unchanged';
        }
        const subscribed = await this.#send('subscribe', this.#toRequest(held.hold, connection, generation.right));
        return subscribed === undefined ? 'unchanged' : toTopicSubscriptionAnswer(subscribed);
    }

    async #unsubscribe(held: HeldTopic, connection: AttachedConnection): Promise<void> {
        const generation = await connection.context.middleware.ownWsConnectionGeneration.read();
        if (generation.right !== undefined) {
            await this.#send('unsubscribe', this.#toRequest(held.hold, connection, generation.right));
        }
    }

    /** Every remote call passes here: undefined, and nothing sent, once remote calls stopped. */
    async #send(
        call: TopicSubscriptionCall,
        request: BrowserTopicSubscriptionRequest
    ): Promise<Either<Error, GroupTopicSubscriptionResult> | undefined> {
        if (this.#remoteCallsStopped) {
            return undefined;
        }
        try {
            const result = call === 'subscribe'
                ? await this.#input.http.subscribeGroupTopic(request)
                : await this.#input.http.unsubscribeGroupTopic(request);
            return Either.ofRight(result);
        }
        catch (error) {
            return Either.ofLeft(toError(error));
        }
    }

    #toRequest(
        hold: BrowserTopicSubscriptions.Hold,
        connection: AttachedConnection,
        connectionGenerationId: string
    ): BrowserTopicSubscriptionRequest {
        const { session } = connection.context;
        return {
            roomRef: hold.roomRef,
            sessionId: session.sessionId,
            body: { topicId: hold.topicId, connectionGenerationId },
            options: { requestId: this.#input.newRequestId(), authSession: session }
        };
    }

    #isCurrent(held: HeldTopic, connection: AttachedConnection): boolean {
        return this.#connection === connection && !this.#remoteCallsStopped && this.#held.get(held.key) === held;
    }

    #stopRemoteCalls(): void {
        this.#remoteCallsStopped = true;
        this.#connection?.stopRenewing();
        this.#endAll();
    }

    #endAll(): readonly HeldTopic[] {
        const ended = [...this.#held.values()];
        for (const held of ended) {
            this.#end(held, 'lapsed');
        }
        return ended;
    }

    #end(held: HeldTopic, status: 'refused' | 'lapsed'): void {
        if (this.#held.get(held.key) === held) {
            this.#held.delete(held.key);
        }
        for (const token of held.tokens) {
            token.settle(status);
        }
        held.tokens.clear();
    }
}
