import type { ApiV1DatabaseNotificationPort } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { createPostgresLiveWsNoticeTransport } from '@api-v1/src/db/create-postgres-live-ws-notice-transport.ts';
import { createJsonWebSocketEvents } from '@api-v1/src/runtime/create-json-web-socket-events.ts';
import {
    installLiveWsNoticeSubscriber,
    sendReceivedLiveWsNotice
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket, type BunWebSocketData } from 'hono/bun';
import postgres from 'postgres';

/**
 * Controlled authenticated identities, production PostgreSQL notification transport, and native loopback
 * WebSockets bridged into the server through the production `hono/bun` events.
 */
export class ArenaTournamentClusterNode {
    readonly physicalBytes: number[] = [];
    readonly socket = new JsonWebSocketServer();
    private readonly engine = new InboxOutboxEngine();
    private readonly database: ReturnType<typeof postgres>;
    private readonly listener: Bun.Server<BunWebSocketData>;
    private readonly clients: WebSocket[] = [];
    readonly service;
    readonly transport;
    readonly channel: string;
    readonly id: string;

    constructor(input: { id: string; databaseUrl: string; channel: string; scope: StateScope; }) {
        this.id = input.id;
        this.channel = input.channel;
        this.database = postgres(input.databaseUrl, { max: 2 });
        const notification: ApiV1DatabaseNotificationPort = {
            notify: async (channel, message) => {
                const text = JSON.stringify(message);
                this.physicalBytes.push(new TextEncoder().encode(text).length);
                await this.database.notify(channel, text);
            },
            listen: async (channel, receive, ready) => {
                await this.database.listen(channel, receive, ready);
            }
        };
        this.transport = createPostgresLiveWsNoticeTransport(notification, Date.now);
        const stores = createDefaultInMemoryALOutboundRuntimeStores({
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        });
        this.service = createDefaultWsQueueBoxServerService({
            name: input.id,
            queueEngine: this.engine,
            socket: this.socket,
            outboundStores: stores,
            outbox: stores.workQueue,
            inboundVolatileStores: undefined,
            readAuthenticatedConnectionScope: (ctx) => ({
                scope: input.scope,
                principalId: ctx.id,
                expiresAtEpochMs: Date.now() + 60000
            })
        });
        const app = new Hono();
        app.get('/:id/:generationId', async (context) => {
            await upgradeWebSocket(
                context,
                createJsonWebSocketEvents(this.socket, {
                    id: context.req.param('id'),
                    generationId: context.req.param('generationId'),
                    generationStartedAtEpochMs: Date.now()
                })
            );
            return new Response(null, { status: 101 });
        });
        this.listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket });
    }

    async subscribe(): Promise<void> {
        await installLiveWsNoticeSubscriber({
            transport: this.transport,
            channel: this.channel,
            publisherId: this.id,
            nowMs: Date.now,
            inboundStores: [],
            resolveBroadRecipientSessionIds: () => [],
            filterEligibleRecipientSessionIds: (ids) => ids.filter((id) => this.socket.connections.get(id)?.isOpen),
            sendToTargetsWithResult: (delivery) => sendReceivedLiveWsNotice(this.service, delivery)
        });
    }

    async connect(id: string, generation: string): Promise<string[]> {
        const client = new WebSocket(`ws://127.0.0.1:${this.listener.port}/${id}/${generation}`);
        this.clients.push(client);
        const frames: string[] = [];
        client.addEventListener('message', (event) => frames.push(String(event.data)));
        await new Promise<void>((resolve, reject) => {
            client.addEventListener('open', () => resolve(), { once: true });
            client.addEventListener('error', () => reject(new Error('Loopback WebSocket failed')), { once: true });
        });
        return frames;
    }

    async stop(): Promise<void> {
        await this.transport.stop();
        for (const client of this.clients) {
            client.close();
        }
        this.listener.stop();
        await this.service.dispose();
        await this.engine.stop();
        await this.database.end();
    }
}
