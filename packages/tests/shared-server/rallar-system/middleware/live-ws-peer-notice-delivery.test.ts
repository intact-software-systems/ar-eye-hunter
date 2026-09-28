import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import { encodeLiveWsNotice, type LiveWsNotice, type LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { newALBroadcastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };

describe('middleware remote live WS notices', () => {
    it.each([
        { mode: 'peer', workspaceId: 'workspace', sentCount: 1 },
        { mode: 'peer', workspaceId: 'other', sentCount: 0 },
        { mode: 'broad', workspaceId: 'other', sentCount: 1 }
    ])('delivers $mode notice to workspace $workspaceId only when eligible', async ({ mode, workspaceId, sentCount }) => {
        let receive: ((notice: LiveWsNotice) => Promise<void> | void) | undefined;
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                await receive?.(notice);
            },
            subscribe: async (_channel, callback) => {
                receive = callback;
            }
        };
        const socket = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://remote');
        native.open();
        socket.addConnection(new ConnectionContext({ id: 'remote-session', socket: native }));
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, appOutbox: resilience } });
        const engine = new InboxOutboxEngine();
        const runtime = createRallarMiddlewareInfrastructure({
            ...fixture.options,
            webSocketServer: socket,
            targetResolver: {},
            readAuthenticatedConnectionScope: (connection) =>
                socket.connections.get(connection.id) === connection
                    ? { scope: { applicationId: 'app', workspaceId }, expiresAtEpochMs: Date.now() + 60_000 }
                    : undefined,
            liveWsNoticeSubscriber: {
                transport,
                channel: 'live',
                publisherId: 'receiver',
                nowMs: Date.now,
                filterEligibleRecipientSessionIds: (ids) => ids
            }
        }, engine);
        onTestFinished(() => {
            runtime.wsQBoxServerService.dispose();
            engine.stop();
        });
        await runtime.liveWsNoticeSubscriberReadiness;
        const route = { topicId: 'app.notice', contextId: 'direct', resourceId: 'notice' };
        const common = { channel: 'live', publisherId: 'remote-publisher', expiresAtMs: Date.now() + 30_000 };
        const encoded = mode === 'peer'
            ? encodeLiveWsNotice({
                ...common,
                scope,
                audience: { mode: 'peer', recipientSessionIds: ['remote-session'] },
                message: newALUnicastMessage('sender', route, 'remote-session', 'notice.v1', { value: 'peer' })
            })
            : encodeLiveWsNotice({
                ...common,
                audience: { mode: 'broad', targetMode: 'all' },
                message: newALBroadcastMessage('sender', route, 'all', 'notice.v1', { value: 'broad' })
            });
        if (encoded.kind !== 'inline') {
            throw new Error('Expected inline notice');
        }

        await transport.publish(encoded.notice);

        expect(native.sent).toHaveLength(sentCount);
        if (sentCount > 0) {
            expect(JSON.parse(String(native.sent[0])).payload.resource).toBe(JSON.stringify({ value: mode }));
        }
    });
});
