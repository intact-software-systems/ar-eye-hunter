import type { ApiV1DatabaseNotificationPort } from '@api-v1/src/db/api-v1-database-lifecycle.ts';
import { createPostgresLiveWsNoticeTransport } from '@api-v1/src/db/create-postgres-live-ws-notice-transport.ts';
import {
    installLiveWsNoticeSubscriber,
    sendReceivedLiveWsNotice
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import postgres from 'postgres';

/** Controlled authenticated identities, production PostgreSQL notification transport, and native loopback WebSockets. */
export class ArenaTournamentClusterNode {
    readonly physicalBytes: number[] = [];
    readonly socket = new JsonWebSocketServer();
    private readonly engine = new InboxOutboxEngine();
    private readonly database: ReturnType<typeof postgres>;
    private readonly listener: Bun.Server<{ id: string; generationId: string; }>;
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
        this.listener = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: (request, server) => {
                const [id, generationId] = new URL(request.url).pathname.slice(1).split('/');
                if (server.upgrade(request, { data: { id, generationId } })) {
                    return;
                }
                return new Response('Expected a WebSocket upgrade', { status: 400 });
            },
            websocket: {
                open: (ws) => {
                    const connection = new ConnectionContext({
                        id: ws.data.id,
                        generationId: ws.data.generationId,
                        socket: ws as unknown as WebSocket
                    });
                    this.socket.registerConnection(connection);
                    this.socket.dispatchConnectionOpen(connection);
                },
                message: (ws, data) => {
                    const connection = this.socket.connections.get(ws.data.id);
                    if (connection !== undefined) {
                        void this.socket.dispatchConnectionMessage(connection, data);
                    }
                },
                close: (ws, code, reason) => {
                    const connection = this.socket.connections.get(ws.data.id) ?? new ConnectionContext({
                        id: ws.data.id,
                        generationId: ws.data.generationId,
                        socket: ws as unknown as WebSocket
                    });
                    this.socket.dispatchConnectionClose(connection, code, reason);
                }
            }
        });
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
