import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { SESSION_HEARTBEAT_INTERVAL_MS } from '@shared-web/browser/session/browser-session-heartbeat.ts';
import type { RallarLifecycleParticipant } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import { GROUP_TOPIC_SUBSCRIPTION_LEASE_MS } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type {
    BrowserTopicSubscriptionHttpApi,
    BrowserTopicSubscriptionRequest
} from './browser-topic-subscription-http-api.ts';
import type { RallarTopicSubscription } from '@shared-web/browser/messages/rallar-message-contracts.ts';
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
    /** One key's remote calls run one at a time, so a release never overtakes the subscribe it ends. */
    remoteCalls: Promise<void>;
}

interface AttachedConnection {
    readonly context: ApiMiddleware;
    readonly stopRenewing: () => void;
}

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
    #connection: AttachedConnection | undefined;
    #replaced = false;

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
        this.#replaced = false;
        context.middleware.webSocketQueueBox.socket.onWebsocketCallbacksDo(SOCKET_CALLBACK_ID, {
            onOpen: () => this.#assertAll(),
            onClose: (event) => {
                if (event.code === 1000 && event.reason === 'connection-replaced') {
                    this.#stopAsReplaced();
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

    /** The releases are best-effort: the server drops a session's elections when it ends or its lease lapses. */
    public detach(): void {
        const connection = this.#connection;
        if (connection === undefined) {
            return;
        }
        this.#connection = undefined;
        connection.stopRenewing();
        connection.context.middleware.webSocketQueueBox.socket.removeWebsocketCallbackById(SOCKET_CALLBACK_ID);
        const ended = this.#endAll();
        if (!this.#replaced) {
            for (const held of ended) {
                void this.#queueRelease(held, connection);
            }
        }
    }

    #startHolding(key: string, hold: BrowserTopicSubscriptions.Hold): HeldTopic {
        const held: HeldTopic = {
            key,
            hold,
            tokens: new Set(),
            status: 'pending',
            lastActiveAtMs: undefined,
            remoteCalls: Promise.resolve()
        };
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
        if (connection !== undefined && !this.#replaced) {
            await this.#queueRelease(held, connection);
        }
    }

    #assertAll(): void {
        for (const held of this.#held.values()) {
            this.#queueAssert(held);
        }
    }

    #queueAssert(held: HeldTopic): void {
        const connection = this.#connection;
        if (connection !== undefined && !this.#replaced) {
            held.remoteCalls = held.remoteCalls.then(async () => await this.#assert(held, connection));
        }
    }

    async #queueRelease(held: HeldTopic, connection: AttachedConnection): Promise<void> {
        held.remoteCalls = held.remoteCalls.then(async () => await this.#unsubscribe(held, connection));
        await held.remoteCalls;
    }

    async #assert(held: HeldTopic, connection: AttachedConnection): Promise<void> {
        if (!this.#isCurrent(held, connection)) {
            return;
        }
        const first = await this.#subscribe(held, connection);
        const answer = first === 'stale-generation' ? await this.#subscribe(held, connection) : first;
        if (!this.#isCurrent(held, connection)) {
            return;
        }
        if (answer === 'unauthorized') {
            connection.stopRenewing();
            this.#endAll();
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
        else if (held.lastActiveAtMs !== undefined && nowMs >= held.lastActiveAtMs + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS) {
            this.#end(held, 'lapsed');
        }
    }

    async #subscribe(held: HeldTopic, connection: AttachedConnection): Promise<TopicSubscriptionAnswer> {
        const request = await this.#readRequest(held, connection);
        if (request === undefined) {
            return 'unchanged';
        }
        try {
            return toTopicSubscriptionAnswer(Either.ofRight(await this.#input.http.subscribeGroupTopic(request)));
        }
        catch (error) {
            return toTopicSubscriptionAnswer(Either.ofLeft(toError(error)));
        }
    }

    async #unsubscribe(held: HeldTopic, connection: AttachedConnection): Promise<void> {
        const request = await this.#readRequest(held, connection);
        if (request === undefined) {
            return;
        }
        try {
            await this.#input.http.unsubscribeGroupTopic(request);
        }
        catch {
            // A release that fails leaves the server's row to lapse with its lease.
        }
    }

    /** Undefined while the socket's generation cannot be read: the next tick or reopen asserts again. */
    async #readRequest(
        held: HeldTopic,
        connection: AttachedConnection
    ): Promise<BrowserTopicSubscriptionRequest | undefined> {
        const { session, middleware } = connection.context;
        const generation = await middleware.ownWsConnectionGeneration.read();
        if (generation.right === undefined) {
            return undefined;
        }
        return {
            roomRef: held.hold.roomRef,
            sessionId: session.sessionId,
            body: { topicId: held.hold.topicId, connectionGenerationId: generation.right },
            options: { requestId: this.#input.newRequestId(), authSession: session }
        };
    }

    #isCurrent(held: HeldTopic, connection: AttachedConnection): boolean {
        return this.#connection === connection && !this.#replaced && this.#held.get(held.key) === held;
    }

    #stopAsReplaced(): void {
        this.#replaced = true;
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
