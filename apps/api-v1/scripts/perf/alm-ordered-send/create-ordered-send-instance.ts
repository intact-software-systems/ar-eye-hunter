import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import {
    createDefaultApiV1DatabaseLifecycle,
    type ApiV1DatabaseLifecycle,
    type ApiV1DatabaseNotificationPort
} from '../../../src/db/api-v1-database-lifecycle.ts';
import { connectOrderedSendSession } from './connect-ordered-send-session.ts';
import { createDelayedDatabaseNotificationPort } from './create-delayed-database-notification-port.ts';
import { createDelayedPSqlSql } from './create-delayed-p-sql-sql.ts';
import { createOrderedSendWsServer, type OrderedSendWsServer } from './create-ordered-send-ws-server.ts';
import { ORDERED_SEND_CELL_CONSTANTS } from './ordered-send-cell-constants.ts';

/** What tells one instance of a run from the others, and what every instance of the run shares. */
export interface OrderedSendInstanceInput {
    /** 0 for instance a, 1 for b, 2 for c. */
    readonly instanceIndex: number;
    /** What each round trip of the instance to the database waits first, in milliseconds; 0 adds nothing. */
    readonly delayMs: number;
    readonly runId: string;
    /** The application and workspace of the run's room. */
    readonly scope: StateScope;
    readonly authorizeRoomMessage: RallarServerWsRoomAuthorizer;
    /** Invoked once each time the instance hands a message to its application. */
    readonly recordHandOff: (message: ALMessage, instanceIndex: number) => void;
}

export interface OrderedSendInstanceDependencies {
    /** The instance's own pools on the run's database. The instance closes it. */
    readonly lifecycle: ApiV1DatabaseLifecycle;
    readonly sleep: (delayMs: number) => Promise<void>;
    readonly nowEpochMs: () => number;
}

/** One API instance of a run: its own pools, its own WS server, and the sessions whose sockets are on it. */
export interface OrderedSendInstance {
    readonly instanceIndex: number;
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

/** The instance's lifecycle as the API's own factory builds it, with the cell's pool sizes, on the run's database. */
export async function createDefaultOrderedSendInstance(
    input: OrderedSendInstanceInput,
    databaseUrl: string
): Promise<OrderedSendInstance> {
    const { applicationPoolMaxConnections, listenerPoolMaxConnections, poolIdleTimeoutSeconds } =
        ORDERED_SEND_CELL_CONSTANTS;
    const lifecycle = await createDefaultApiV1DatabaseLifecycle({
        database: {
            mode: 'postgres',
            url: databaseUrl,
            schemaInitialization: 'disabled',
            pubSub: 'postgres',
            applicationPool: {
                maxConnections: applicationPoolMaxConnections,
                idleTimeoutSeconds: poolIdleTimeoutSeconds
            },
            listenerPool: { maxConnections: listenerPoolMaxConnections, idleTimeoutSeconds: poolIdleTimeoutSeconds }
        },
        pgliteEvidence: { mode: 'disabled', pollIntervalMs: 1_000 },
        statementCensus: undefined
    });
    return createOrderedSendInstance(input, {
        lifecycle,
        sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
        nowEpochMs: Date.now
    });
}

/**
 * One instance over its lifecycle. Its WS server sends every statement through the delayed handle and publishes
 * every NOTIFY through the delayed port; only the pool's warm-up uses the lifecycle's own handle.
 */
export function createOrderedSendInstance(
    input: OrderedSendInstanceInput,
    dependencies: OrderedSendInstanceDependencies
): OrderedSendInstance {
    const { lifecycle, sleep, nowEpochMs } = dependencies;
    const { instanceIndex, delayMs } = input;
    const server = createOrderedSendWsServer({
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
        nowEpochMs
    });
    const disconnects: (() => void)[] = [];
    return {
        instanceIndex,
        acceptIncomingMessage: (value, connectionId) => server.service.acceptIncomingMessage(value, connectionId),
        warmApplicationPool: () => warmApplicationPool(lifecycle.database),
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
        stop: () => stopOrderedSendWsServer(server, disconnects),
        close: () => lifecycle.close()
    };
}

function requireNotificationPort(lifecycle: ApiV1DatabaseLifecycle): ApiV1DatabaseNotificationPort {
    if (lifecycle.notification === null) {
        throw new TypeError('An ordered-send instance needs a lifecycle with a PostgreSQL notification port.');
    }
    return lifecycle.notification;
}

/** One statement for each connection the pool may open, all held at once, on the lifecycle's own handle. */
async function warmApplicationPool(database: PSqlSql): Promise<void> {
    await Promise.all(
        Array.from(
            { length: ORDERED_SEND_CELL_CONSTANTS.applicationPoolMaxConnections },
            () => database<readonly object[]>`select pg_sleep(${WARM_HOLD_SECONDS})`
        )
    );
}

async function startOrderedSendWsServer(server: OrderedSendWsServer): Promise<void> {
    await server.subscriptionsReady;
    server.queueEngine.start();
}

/** Runs each step in turn whatever the one before it did, then fails with every failure there was. */
async function stopOrderedSendWsServer(server: OrderedSendWsServer, disconnects: (() => void)[]): Promise<void> {
    const steps: readonly (() => Promise<void> | void)[] = [
        () => server.queueEngine.stop(),
        () => server.service.dispose(),
        () => server.stopLiveNotices(),
        () => disconnects.splice(0).forEach((disconnect) => disconnect())
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
