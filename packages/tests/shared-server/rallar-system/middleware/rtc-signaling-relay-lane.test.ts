import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { installRtcSignalingWsTopic } from '@shared-server/rallar-system/communication/install-rtc-signaling-ws-topic.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import type { CreateRallarMiddlewareOptions } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    createPSqlAdmissionTestStorage,
    type PSqlAdmissionTestStorage
} from '../../al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

interface RelayServer {
    readonly runtime: RallarMiddlewareRuntime;
    readonly durable: ALInboundRuntimeStores;
    readonly volatile: ALVolatileInboundRuntimeStores;
    readonly sender: SimulatedWebSocket;
    readonly receiver: SimulatedWebSocket;
    readonly statements: () => number;
}

describe('the WS server relay lane', () => {
    it('admits and relays a best-effort RTC signal in memory, issuing no SQL statement', async () => {
        const server = await createRelayServer();
        // The first arrival also starts the durable lane, whose recovery scans its work pages once.
        const warmup = signalingMessage('offer-0');
        await server.sender.receive(JSON.stringify(warmup));
        await expect.poll(() => server.receiver.sent).toEqual([JSON.stringify(warmup)]);
        const signal = signalingMessage('offer-1');
        const before = server.statements();

        await server.sender.receive(JSON.stringify(signal));

        await expect.poll(() => server.receiver.sent).toEqual([JSON.stringify(warmup), JSON.stringify(signal)]);
        expect(server.statements() - before).toBe(0);
        expect(await server.volatile.admissionStore.readDeliverySurface(toReference(signal), Date.now()))
            .toMatchObject({ msg: { id: { msgId: signal.id.msgId } } });
    });

    it('keeps a local-inbox message in the durable store', async () => {
        const server = await createRelayServer();
        const message = durableMessage();
        const before = server.statements();

        await server.sender.receive(JSON.stringify(message));

        await expect.poll(async () => await server.durable.admissionStore.readDeliverySurface(toReference(message), Date.now())).toMatchObject({
            msg: { id: { msgId: message.id.msgId } }
        });
        expect(server.statements() - before).toBeGreaterThan(0);
        expect(await server.volatile.admissionStore.readDeliverySurface(toReference(message), Date.now()))
            .toBeUndefined();
    });

    it('refuses an instance-local memory lane beside acknowledgements relayed to other instances', () => {
        const fixture = createRallarMiddlewareTestRuntime({ resilience: createResilience() });

        expect(() =>
            createRallarMiddleware({
                ...fixture.options,
                inboundVolatileStores: createVolatileALInboundRuntimeStores({ namespace: 'relay-lane' }, undefined),
                relayedAckNotices: {
                    transport: { publish: async () => undefined, subscribe: async () => undefined },
                    channel: 'relayed-acks',
                    publisherId: 'server-a'
                }
            })
        ).toThrow(TypeError);
    });
});

async function createRelayServer(): Promise<RelayServer> {
    const storage = await createPSqlAdmissionTestStorage();
    const statements = countPGliteStatements(storage.sql.raw);
    const durable = createPSqlALInboundRuntimeStores({
        repository: storage.repository,
        namespace: 'server-ws-qbox:relay-lane',
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined
    });
    const volatile = createVolatileALInboundRuntimeStores({ namespace: 'server-ws-qbox:relay-lane:volatile' }, undefined);
    const socket = new JsonWebSocketServer();
    const sender = await openConnection(socket, 'sender');
    const receiver = await openConnection(socket, 'receiver');
    const fixture = createRallarMiddlewareTestRuntime({ resilience: createResilience() });
    const runtime = createRallarMiddleware({
        ...fixture.options,
        webSocketServer: socket,
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        inboundStores: durable,
        inboundVolatileStores: volatile
    });
    installRtcSignalingWsTopic(runtime.wsQBoxServerService, undefined, Date.now);
    onTestFinished(() => runtime.wsQBoxServerService.dispose());
    return { runtime, durable, volatile, sender, receiver, statements };
}

async function openConnection(socket: JsonWebSocketServer, id: string): Promise<SimulatedWebSocket> {
    const native = new SimulatedWebSocket(`ws://${id}`);
    await native.open();
    socket.addConnection(new ConnectionContext({ id, socket: native }));
    return native;
}

/** Every statement the PGlite instance runs, inside a transaction as well as outside, with its BEGIN and COMMIT. */
function countPGliteStatements(raw: PSqlAdmissionTestStorage['sql']['raw']): () => number {
    let statements = 0;
    const query = raw.query.bind(raw);
    const exec = raw.exec.bind(raw);
    const transaction = raw.transaction.bind(raw);
    vi.spyOn(raw, 'query').mockImplementation((...args: Parameters<typeof raw.query>) => {
        statements += 1;
        return query(...args);
    });
    vi.spyOn(raw, 'exec').mockImplementation((...args: Parameters<typeof raw.exec>) => {
        statements += 1;
        return exec(...args);
    });
    vi.spyOn(raw, 'transaction').mockImplementation((callback) => {
        statements += 2;
        return transaction((tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    statements += 1;
                    return txQuery(...args);
                }
            }));
        });
    });
    return () => statements;
}

function createResilience(): CreateRallarMiddlewareOptions['resilience'] {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilience = ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
    return { inbox: resilience, outbox: resilience, appOutbox: resilience };
}

function toReference(message: ALMessage): { readonly senderId: string; readonly msgId: string; } {
    return { senderId: message.id.senderId, msgId: message.id.msgId };
}

function signalingMessage(offerId: string): ALMessage {
    return newALUnicastMessage(
        'sender',
        newALEventRoute(AppTopics.rtcSignaling, 'receiver', 'offer'),
        'receiver',
        AppTopics.rtcSignaling,
        {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'sender',
            toId: 'receiver',
            sessionId: 'sender',
            token: 'fixture-ticket',
            signalType: 'Offer',
            offerId,
            payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: null }
        }
    );
}

function durableMessage(): ALMessage {
    return {
        ...newALUnicastMessage('sender', newALEventRoute('app.notes', 'receiver', 'note'), 'receiver', 'notes.v1', {
            text: 'kept'
        }),
        qos: { durability: { algo: 'local-inbox' } }
    };
}
