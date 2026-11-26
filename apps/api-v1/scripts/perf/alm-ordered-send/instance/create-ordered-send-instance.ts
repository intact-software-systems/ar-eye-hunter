import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import type { ApiV1CircuitBreakerConfiguration } from '../../../../src/configuration/api-v1-configuration.ts';
import {
    createDefaultApiV1DatabaseLifecycle,
    type ApiV1DatabaseLifecycle,
    type ApiV1DatabaseNotificationPort
} from '../../../../src/db/api-v1-database-lifecycle.ts';
import { ORDERED_SEND_API_V1_DEFAULTS } from '../ordered-send-api-v1-defaults.ts';
import { ORDERED_SEND_CELL_CONSTANTS } from '../ordered-send-cell-constants.ts';
import type { OrderedSendClock } from '../ordered-send-clock.ts';
import { connectOrderedSendSession, type OrderedSendSessionDisconnect } from './connect-ordered-send-session.ts';
import { createDelayedDatabaseNotificationPort } from './create-delayed-database-notification-port.ts';
import { createDelayedPSqlSql } from './create-delayed-p-sql-sql.ts';
import { createOrderedSendWsServer, type OrderedSendWsServer } from './create-ordered-send-ws-server.ts';

/** What tells one instance of a run from the others, and what every instance of the run shares. */
export interface OrderedSendInstanceInput {
    /** 0 for instance a, 1 for b, 2 for c. */
    readonly instanceIndex: number;
    /** What each round trip of the instance to the database waits first, in milliseconds; 0 adds nothing. */
    readonly delayMs: number;
    /** The most connections the instance's application pool opens: its statements and transactions share them. */
    readonly applicationPoolMaxConnections: number;
    readonly runId: string;
    /** The application and workspace of the run's room. */
    readonly scope: StateScope;
    readonly authorizeRoomMessage: RallarServerWsRoomAuthorizer;
    /** Invoked once each time the instance hands a message to its application. */
    readonly recordHandOff: (message: ALMessage, instanceIndex: number) => void;
}

/** What an instance takes from the API's configuration. */
export interface OrderedSendInstanceConfig {
    /** The circuit breaker of the instance's queue reads. */
    readonly queueResilience: ApiV1CircuitBreakerConfiguration;
}

export interface OrderedSendInstanceDependencies {
    /** The instance's own pools on the run's database. The instance closes it. */
    readonly lifecycle: ApiV1DatabaseLifecycle;
    /** The run's clock: the delays wait through it, and the connects and the notices take their epoch time from it. */
    readonly clock: OrderedSendClock;
}

/** One API instance of a run: its own pools, its own WS server, and the sessions whose sockets are on it. */
export interface OrderedSendInstance {
    readonly instanceIndex: number;
    /** The most connections the instance's application pool opens. */
    readonly applicationPoolMaxConnections: number;
    /** The entry a frame of a session connected here reaches, as its socket's frame would. */
    readonly acceptIncomingMessage: WsQueueBoxServerService['acceptIncomingMessage'];
    /** Opens every connection of the application pool, so the send window opens none. */
    warmApplicationPool(): Promise<void>;
    /** Waits for the instance's LISTEN subscriptions, then starts its queue workers. */
    start(): Promise<void>;
    connectSession(sessionPeerId: string, socket: ConnectionContext.Socket): void;
    /** Stops the queue workers, disposes the WS service and disconnects the sessions; the pools stay open. */
    stop(): Promise<void>;
    /** Closes the instance's pools. */
    close(): Promise<void>;
}

/** How long each warming statement holds its connection: long enough that all of them overlap. */
const WARM_HOLD_SECONDS = 0.1;

/** A session's authorisation outlasts any run by far. */
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * One instance on the run's database, over a lifecycle the API's own factory builds. The size of its application
 * pool is its input's, which is the run's shape's. The circuit breaker of its queue reads is the API's default. The
 * listener pool's size and the idle time of both pools are the cell's own.
 */
export async function createDefaultOrderedSendInstance(
    input: OrderedSendInstanceInput,
    databaseUrl: string,
    clock: OrderedSendClock
): Promise<OrderedSendInstance> {
    const { listenerPoolMaxConnections, poolIdleTimeoutSeconds } = ORDERED_SEND_CELL_CONSTANTS;
    const lifecycle = await createDefaultApiV1DatabaseLifecycle({
        database: {
            mode: 'postgres',
            url: databaseUrl,
            schemaInitialization: 'disabled',
            pubSub: 'postgres',
            applicationPool: {
                maxConnections: input.applicationPoolMaxConnections,
                idleTimeoutSeconds: poolIdleTimeoutSeconds
            },
            listenerPool: { maxConnections: listenerPoolMaxConnections, idleTimeoutSeconds: poolIdleTimeoutSeconds }
        },
        pgliteEvidence: { mode: 'disabled', pollIntervalMs: 1_000 },
        statementCensus: undefined
    });
    return await createOrderedSendInstance(
        input,
        { queueResilience: ORDERED_SEND_API_V1_DEFAULTS.queueResilience },
        { lifecycle, clock }
    );
}

/**
 * One instance over its lifecycle, which it owns from here on: an instance that cannot be wired closes the lifecycle
 * before it fails. Its WS server sends every statement through the delayed handle and publishes every NOTIFY through
 * the delayed port; only the pool's warm-up uses the lifecycle's own handle.
 */
export async function createOrderedSendInstance(
    input: OrderedSendInstanceInput,
    config: OrderedSendInstanceConfig,
    dependencies: OrderedSendInstanceDependencies
): Promise<OrderedSendInstance> {
    try {
        return wireOrderedSendInstance(input, config, dependencies);
    }
    catch (error) {
        try {
            await dependencies.lifecycle.close();
        }
        catch (closeError) {
            throw new AggregateError(
                [toError(error), toError(closeError)],
                'An ordered-send instance failed to be wired, and its lifecycle failed to close.'
            );
        }
        throw error;
    }
}

function wireOrderedSendInstance(
    input: OrderedSendInstanceInput,
    config: OrderedSendInstanceConfig,
    dependencies: OrderedSendInstanceDependencies
): OrderedSendInstance {
    const { lifecycle } = dependencies;
    const { nowEpochMs } = dependencies.clock;
    const { instanceIndex } = input;
    const server = createDelayedOrderedSendWsServer(input, config, dependencies);
    const disconnects: OrderedSendSessionDisconnect[] = [];
    return {
        instanceIndex,
        applicationPoolMaxConnections: input.applicationPoolMaxConnections,
        acceptIncomingMessage: (value, connectionId) => server.service.acceptIncomingMessage(value, connectionId),
        warmApplicationPool: () => warmApplicationPool(lifecycle.database, input.applicationPoolMaxConnections),
        start: () => startOrderedSendWsServer(server),
        connectSession: (sessionPeerId, socket) => {
            disconnects.push(connectOrderedSendSession({
                socketServer: server.socketServer,
                sessionPeerId,
                scope: input.scope,
                socket,
                connectedAtEpochMs: nowEpochMs(),
                authorisationLifetimeMs: SESSION_LIFETIME_MS
            }));
        },
        stop: () => stopOrderedSendWsServer(server, disconnects, nowEpochMs),
        close: () => lifecycle.close()
    };
}

/** The instance's WS server over the delayed handle and the delayed port of its lifecycle. */
function createDelayedOrderedSendWsServer(
    input: OrderedSendInstanceInput,
    config: OrderedSendInstanceConfig,
    dependencies: OrderedSendInstanceDependencies
): OrderedSendWsServer {
    const { lifecycle } = dependencies;
    const { sleep, nowEpochMs } = dependencies.clock;
    const { instanceIndex, delayMs } = input;
    return createOrderedSendWsServer({
        sql: createDelayedPSqlSql({ sql: lifecycle.database, delayMs, sleep }),
        notification: createDelayedDatabaseNotificationPort({
            notification: requireNotificationPort(lifecycle),
            delayMs,
            sleep
        }),
        runId: input.runId,
        publisherId: `ordered-send-${input.runId}-instance-${instanceIndex}`,
        authorizeRoomMessage: input.authorizeRoomMessage,
        recordHandOff: (message) => input.recordHandOff(message, instanceIndex),
        queueResilience: config.queueResilience,
        nowEpochMs
    });
}

function requireNotificationPort(lifecycle: ApiV1DatabaseLifecycle): ApiV1DatabaseNotificationPort {
    if (lifecycle.notification === null) {
        throw new TypeError('An ordered-send instance needs a lifecycle with a PostgreSQL notification port.');
    }
    return lifecycle.notification;
}

/** One statement for each connection the pool may open, all held at once, on the lifecycle's own handle. */
async function warmApplicationPool(database: PSqlSql, applicationPoolMaxConnections: number): Promise<void> {
    await Promise.all(
        Array.from(
            { length: applicationPoolMaxConnections },
            () => database<readonly object[]>`select pg_sleep(${WARM_HOLD_SECONDS})`
        )
    );
}

async function startOrderedSendWsServer(server: OrderedSendWsServer): Promise<void> {
    await server.subscriptionsReady;
    server.queueEngine.start();
}

/** Runs each step in turn whatever the one before it did, then fails with every failure there was. */
async function stopOrderedSendWsServer(
    server: OrderedSendWsServer,
    disconnects: OrderedSendSessionDisconnect[],
    nowEpochMs: () => number
): Promise<void> {
    const steps: readonly (() => Promise<void> | void)[] = [
        () => server.queueEngine.stop(),
        () => server.service.dispose(),
        () => server.stopLiveNotices(),
        () => disconnects.splice(0).forEach((disconnect) => disconnect(nowEpochMs()))
    ];
    const failures: Error[] = [];
    for (const step of steps) {
        try {
            await step();
        }
        catch (error) {
            failures.push(toError(error));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'An ordered-send instance failed to stop.');
    }
}
