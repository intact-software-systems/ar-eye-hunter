import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type {
    BrowserTopicSubscriptionHttpApi,
    BrowserTopicSubscriptionRequest
} from '@shared-web/browser/messages/topic-subscription/browser-topic-subscription-http-api.ts';
import { BrowserTopicSubscriptions } from '@shared-web/browser/messages/topic-subscription/browser-topic-subscriptions.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { GroupTopicSubscriptionResult } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import { Either } from '@shared/resilience/Either.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import type { JsonWebSocketClient, WebSocketClientCallbacks } from '@shared/websocket/json-web-socket-client.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';

/** One REST call the owner made, as the effect log every test asserts. */
interface RecordedTopicSubscriptionCall {
    readonly call: 'subscribe' | 'unsubscribe';
    readonly groupId: string;
    readonly sessionId: string;
    readonly topicId: string;
    readonly connectionGenerationId: string;
    readonly requestId: string;
}

type TopicSubscriptionAnswer = (request: BrowserTopicSubscriptionRequest) => Promise<GroupTopicSubscriptionResult>;

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const OTHER_ROOM_REF = { ...ROOM_REF, groupId: 'room-2' };

let calls: RecordedTopicSubscriptionCall[] = [];
let answer: TopicSubscriptionAnswer = async () => ({ outcome: 'subscribed' });
let generation: Either<Error, string> = Either.ofRight('generation-1');
let socketCallbacks: Map<string, WebSocketClientCallbacks>;
let requestCount = 0;
let newRequestId: () => string = () => `request-${++requestCount}`;

/** The socket's generation reader: `read` goes Left once the socket closes; `readKnown` is the open socket's cached id. */
interface GenerationReader {
    read(): Promise<Either<Error, string>>;
    readKnown(): string | undefined;
}

const currentGenerationReader: GenerationReader = {
    read: async () => generation,
    readKnown: () => generation.right
};

describe('browser topic subscriptions', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        calls = [];
        answer = async () => ({ outcome: 'subscribed' });
        generation = Either.ofRight('generation-1');
        socketCallbacks = new Map();
        requestCount = 0;
        newRequestId = () => `request-${++requestCount}`;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('the first token subscribes and settles active', async () => {
        const owner = createAttachedOwner();

        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const statusBefore = token.status();

        expect([statusBefore, await token.wait(), token.status()]).toEqual(['pending', 'active', 'active']);
        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
    });

    it('a hold made before attach waits pending and is sent on attach', async () => {
        const owner = createOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const callsBeforeAttach = [...calls];

        owner.attach(createContext());

        expect([callsBeforeAttach, await token.wait()]).toEqual([[], 'active']);
        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
    });

    it('two tokens on one key send one subscribe and the first unsubscribe sends nothing', async () => {
        const owner = createAttachedOwner();
        const first = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const second = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await Promise.all([first.wait(), second.wait()]);

        await first.unsubscribe();

        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
        expect([first.status(), second.status()]).toEqual(['lapsed', 'active']);
    });

    it('the last unsubscribe releases with the current generation', async () => {
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await token.wait();
        generation = Either.ofRight('generation-2');

        await token.unsubscribe();

        expect(calls).toEqual([
            subscribeCall('room.feed', 'generation-1', 'request-1'),
            { ...subscribeCall('room.feed', 'generation-2', 'request-2'), call: 'unsubscribe' }
        ]);
    });

    it('the loop renews each held key every 20 s with a fresh requestId', async () => {
        const owner = createAttachedOwner();
        const feed = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const score = owner.hold({ roomRef: OTHER_ROOM_REF, topicId: 'room.score' });
        await Promise.all([feed.wait(), score.wait()]);

        await vi.advanceTimersByTimeAsync(19_999);
        const callsBeforeTick = calls.length;
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(callsBeforeTick).toBe(2);
        expect(calls.map((call) => [call.groupId, call.topicId, call.requestId])).toEqual([
            ['room-1', 'room.feed', 'request-1'],
            ['room-2', 'room.score', 'request-2'],
            ['room-1', 'room.feed', 'request-3'],
            ['room-2', 'room.score', 'request-4'],
            ['room-1', 'room.feed', 'request-5'],
            ['room-2', 'room.score', 'request-6']
        ]);
        expect([feed.status(), score.status()]).toEqual(['active', 'active']);
    });

    it('a reopen re-asserts every held key with the new generation', async () => {
        const owner = createAttachedOwner();
        const feed = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const score = owner.hold({ roomRef: ROOM_REF, topicId: 'room.score' });
        await Promise.all([feed.wait(), score.wait()]);
        generation = Either.ofRight('generation-2');

        openSocket();
        await vi.advanceTimersByTimeAsync(0);

        expect(calls.slice(2)).toEqual([
            subscribeCall('room.feed', 'generation-2', 'request-3'),
            subscribeCall('room.score', 'generation-2', 'request-4')
        ]);
    });

    it('a Left generation read sends nothing and the next tick retries', async () => {
        generation = Either.ofLeft(new Error('The WebSocket is not open.'));
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const before = { calls: [...calls], status: token.status() };
        generation = Either.ofRight('generation-1');

        await vi.advanceTimersByTimeAsync(20_000);

        expect(before).toEqual({ calls: [], status: 'pending' });
        expect([calls, token.status()]).toEqual([[subscribeCall('room.feed', 'generation-1', 'request-1')], 'active']);
    });

    it('no-subscribe-grant refuses and stops renewing', async () => {
        answer = async () => {
            throw toPolicyDenial('no-subscribe-grant');
        };
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });

        const settled = await token.wait();
        await vi.advanceTimersByTimeAsync(60_000);

        expect([settled, token.status()]).toEqual(['refused', 'refused']);
        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
    });

    it('a renewal answering member-not-active after a departure refuses the token', async () => {
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await token.wait();
        answer = async () => {
            throw toPolicyDenial('member-not-active');
        };

        await vi.advanceTimersByTimeAsync(20_000);

        expect(token.status()).toBe('refused');
    });

    it('stale-generation re-reads the generation once and retries the subscribe with it', async () => {
        answer = async (request) => {
            if (request.body.connectionGenerationId === 'generation-1') {
                throw toPolicyDenial('stale-generation');
            }
            return { outcome: 'subscribed' };
        };
        const owner = createAttachedOwner({
            read: async () => {
                const read = generation;
                generation = Either.ofRight('generation-2');
                return read;
            },
            readKnown: () => generation.right
        });

        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });

        expect(await token.wait()).toBe('active');
        expect(calls).toEqual([
            subscribeCall('room.feed', 'generation-1', 'request-1'),
            subscribeCall('room.feed', 'generation-2', 'request-2')
        ]);
    });

    it('a second stale-generation after the re-read refuses the token', async () => {
        answer = async () => {
            throw toPolicyDenial('stale-generation');
        };
        const owner = createAttachedOwner();

        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });

        expect(await token.wait()).toBe('refused');
        expect(calls.map((call) => call.requestId)).toEqual(['request-1', 'request-2']);
    });

    it('stale-generation keeps the token pending when the socket closed, and the reopen re-asserts', async () => {
        answer = async (request) => {
            if (request.body.connectionGenerationId === 'generation-1') {
                generation = Either.ofLeft(new Error('The WebSocket is not open.'));
                throw toPolicyDenial('stale-generation');
            }
            return { outcome: 'subscribed' };
        };
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const statusBeforeReopen = token.status();
        generation = Either.ofRight('generation-2');

        openSocket();

        expect([statusBeforeReopen, await token.wait()]).toEqual(['pending', 'active']);
        expect(calls).toEqual([
            subscribeCall('room.feed', 'generation-1', 'request-1'),
            subscribeCall('room.feed', 'generation-2', 'request-2')
        ]);
    });

    it('no-live-session keeps the token as it is and the next tick retries', async () => {
        let answered = 0;
        answer = async () => {
            answered += 1;
            if (answered === 1) {
                throw toPolicyDenial('no-live-session');
            }
            return { outcome: 'subscribed' };
        };
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const statusBeforeTick = token.status();

        await vi.advanceTimersByTimeAsync(20_000);

        expect([statusBeforeTick, token.status(), calls.length]).toEqual(['pending', 'active', 2]);
    });

    it('a lease without a successful renewal lapses the token', async () => {
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await token.wait();
        answer = async () => {
            throw new ApiHttpError('POST', '/subscribe', 503, 'unavailable');
        };

        await vi.advanceTimersByTimeAsync(100_000);
        const statusWithinLease = token.status();
        await vi.advanceTimersByTimeAsync(20_000);
        const callsAtLapse = calls.length;
        await vi.advanceTimersByTimeAsync(40_000);

        expect([statusWithinLease, token.status()]).toEqual(['active', 'lapsed']);
        expect(calls.length).toBe(callsAtLapse);
    });

    it('a 401 lapses every token and stops the loop', async () => {
        const owner = createAttachedOwner();
        const feed = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const score = owner.hold({ roomRef: ROOM_REF, topicId: 'room.score' });
        await Promise.all([feed.wait(), score.wait()]);
        answer = async () => {
            throw new ApiHttpError('POST', '/subscribe', 401, 'expired');
        };

        await vi.advanceTimersByTimeAsync(20_000);
        const callsAfterUnauthorized = calls.length;
        answer = async () => ({ outcome: 'subscribed' });
        const later = owner.hold({ roomRef: ROOM_REF, topicId: 'room.later' });
        await vi.advanceTimersByTimeAsync(140_000);

        expect([feed.status(), score.status(), later.status()]).toEqual(['lapsed', 'lapsed', 'pending']);
        expect(calls.length).toBe(callsAfterUnauthorized);
    });

    it('a replaced tab releases nothing remotely and its tokens lapse', async () => {
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await token.wait();

        closeSocket(1000, 'connection-replaced');
        await vi.advanceTimersByTimeAsync(60_000);
        await token.unsubscribe();
        owner.hold({ roomRef: ROOM_REF, topicId: 'room.score' });
        owner.detach();
        await vi.advanceTimersByTimeAsync(0);

        expect(token.status()).toBe('lapsed');
        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
    });

    it('a subscribe made while the key\'s release is pending is sent after the release', async () => {
        const firstAnswer = Promise.withResolvers<GroupTopicSubscriptionResult>();
        answer = async () => calls.length === 1 ? await firstAnswer.promise : { outcome: 'subscribed' };
        const owner = createAttachedOwner();
        const first = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const released = first.unsubscribe();
        const second = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const callsWhileFirstPending = calls.map((call) => call.call);

        firstAnswer.resolve({ outcome: 'subscribed' });
        await released;

        expect([callsWhileFirstPending, await second.wait()]).toEqual([['subscribe'], 'active']);
        expect(calls.map((call) => call.call)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
    });

    it('a connection-replaced close while a subscribe is in flight sends no stale-generation retry', async () => {
        const firstAnswer = Promise.withResolvers<GroupTopicSubscriptionResult>();
        answer = async () => await firstAnswer.promise;
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);

        closeSocket(1000, 'connection-replaced');
        firstAnswer.reject(toPolicyDenial('stale-generation'));
        await vi.advanceTimersByTimeAsync(60_000);

        expect([calls.length, token.status()]).toEqual([1, 'lapsed']);
    });

    it('a failed call does not stop the later calls of its key', async () => {
        let failNextRequestId = true;
        newRequestId = () => {
            if (failNextRequestId) {
                failNextRequestId = false;
                throw new Error('No request id.');
            }
            return `request-${++requestCount}`;
        };
        const owner = createAttachedOwner();
        const token = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        await vi.advanceTimersByTimeAsync(0);
        const statusAfterFailure = token.status();

        await vi.advanceTimersByTimeAsync(20_000);

        expect([statusAfterFailure, token.status()]).toEqual(['pending', 'active']);
        expect(calls).toEqual([subscribeCall('room.feed', 'generation-1', 'request-1')]);
    });

    it('detach releases every key best-effort and lapses the tokens', async () => {
        const owner = createAttachedOwner();
        const feed = owner.hold({ roomRef: ROOM_REF, topicId: 'room.feed' });
        const score = owner.hold({ roomRef: OTHER_ROOM_REF, topicId: 'room.score' });
        await Promise.all([feed.wait(), score.wait()]);
        answer = async () => {
            throw new ApiHttpError('POST', '/unsubscribe', 401, 'expired');
        };

        owner.detach();
        // The transport shutdown closes the socket in the tick detach runs in, so a read after it is Left.
        generation = Either.ofLeft(new Error('The WebSocket is not open.'));
        await vi.advanceTimersByTimeAsync(60_000);

        expect([feed.status(), score.status()]).toEqual(['lapsed', 'lapsed']);
        expect(calls.map((call) => [call.call, call.groupId, call.topicId, call.connectionGenerationId])).toEqual([
            ['subscribe', 'room-1', 'room.feed', 'generation-1'],
            ['subscribe', 'room-2', 'room.score', 'generation-1'],
            ['unsubscribe', 'room-1', 'room.feed', 'generation-1'],
            ['unsubscribe', 'room-2', 'room.score', 'generation-1']
        ]);
        expect(socketCallbacks.size).toBe(0);
    });
});

function createOwner(): BrowserTopicSubscriptions {
    const http: BrowserTopicSubscriptionHttpApi = {
        subscribeGroupTopic: async (request) => await recordCall('subscribe', request),
        unsubscribeGroupTopic: async (request) => await recordCall('unsubscribe', request)
    };
    return new BrowserTopicSubscriptions({
        http,
        timers: createDefaultTimers(),
        newRequestId: () => newRequestId()
    });
}

function createAttachedOwner(
    generationReader: GenerationReader = currentGenerationReader
): BrowserTopicSubscriptions {
    const owner = createOwner();
    owner.attach(createContext(generationReader));
    return owner;
}

function createContext(
    generationReader: GenerationReader = currentGenerationReader
): ApiMiddleware {
    const socket: Partial<JsonWebSocketClient> = {
        onWebsocketCallbacksDo: (id, callbacks) => {
            socketCallbacks.set(id, callbacks);
            return socket as JsonWebSocketClient;
        },
        removeWebsocketCallbackById: (id) => socketCallbacks.delete(id)
    };
    return createDefaultApiMiddlewareTestDouble({
        middleware: {
            ownWsConnectionGeneration: {
                read: async () => await generationReader.read(),
                readKnown: () => generationReader.readKnown()
            },
            webSocketQueueBox: { socket: socket as JsonWebSocketClient }
        }
    });
}

async function recordCall(
    call: RecordedTopicSubscriptionCall['call'],
    request: BrowserTopicSubscriptionRequest
): Promise<GroupTopicSubscriptionResult> {
    calls.push({
        call,
        groupId: request.roomRef.groupId,
        sessionId: request.sessionId,
        topicId: request.body.topicId,
        connectionGenerationId: request.body.connectionGenerationId,
        requestId: request.options.requestId
    });
    return call === 'subscribe' ? await answer(request) : await answerRelease(request);
}

async function answerRelease(request: BrowserTopicSubscriptionRequest): Promise<GroupTopicSubscriptionResult> {
    await answer(request);
    return { outcome: 'unsubscribed' };
}

function subscribeCall(topicId: string, connectionGenerationId: string, requestId: string): RecordedTopicSubscriptionCall {
    return { call: 'subscribe', groupId: 'room-1', sessionId: 'session-1', topicId, connectionGenerationId, requestId };
}

function toPolicyDenial(code: string): ApiHttpError {
    return new ApiHttpError(
        'POST',
        '/subscribe',
        403,
        JSON.stringify({
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code,
            status: 403,
            message: code,
            issues: null,
            denial: { code, message: code, details: null },
            retry: null
        })
    );
}

function openSocket(): void {
    for (const callbacks of socketCallbacks.values()) {
        callbacks.onOpen?.(new Event('open'));
    }
}

function closeSocket(code: number, reason: string): void {
    for (const callbacks of socketCallbacks.values()) {
        callbacks.onClose?.(new CloseEvent('close', { code, reason }));
    }
}
