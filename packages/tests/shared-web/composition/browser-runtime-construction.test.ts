import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
import { createBrowserRuntimeFoundation } from '@shared-web/browser/composition/browser-runtime-composition.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const runtime = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import(
        '../api-middleware-test-double.ts'
    );
    const middleware = createDefaultApiMiddlewareTestDouble();

    return {
        middleware,
        initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
        readSession: vi.fn<AuthModule['readSession']>()
    };
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    async (importOriginal): Promise<MiddlewareModule> => ({
        ...await importOriginal(),
        initialiseMiddleware: runtime.initialiseMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), async (importOriginal): Promise<AuthModule> => ({
    ...await importOriginal(),
    clearSession: vi.fn(),
    isLoggedIn: () => true,
    readSession: runtime.readSession,
    writeSession: vi.fn()
}));

describe('browser runtime construction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configureTestCacheRepositories();
        runtime.initialiseMiddleware.mockResolvedValue(runtime.middleware.middleware);
        runtime.readSession.mockReturnValue(runtime.middleware.session);
    });

    afterEach(async () => {
        const { browserTransportRuntime } = await import('@shared-web/browser/connection/browser-transport-runtime.ts');
        browserTransportRuntime?.shutdown();
    });

    it('keeps browser runtime state isolated per completed facade foundation', () => {
        const foundation = createBrowserRuntimeFoundation();

        expect(foundation.connectionRuntime.readMiddleware()).toBeUndefined();
    });

    it('selects the conformance policy at black-box construction while ordinary facade construction keeps defaults', async () => {
        const { createBlackBoxBrowserRallarRuntimeDependency } = await import(
            '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts'
        );
        const { createRallarFacade } = await import('@shared-web/browser/composition/create-rallar-facade.ts');
        const message = newALMulticastMessage(
            'sender',
            { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'one' },
            { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            'alm.lifecycle',
            { marker: 'delivery-lifecycle', specimen: 'supersedence' }
        );
        const selectedPolicies: string[] = [];
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            selectedPolicies.push(
                normalizeALQosPolicy(message, resolveALQosNormalizationInput(message, { direction: 'outbound' }, options.qosProvider)).effective.supersedence
                    .algo
            );
            return runtime.middleware.middleware;
        });
        const blackBox = createBlackBoxBrowserRallarRuntimeDependency();
        await blackBox.connect();
        await blackBox.disconnect();
        const ordinary = createRallarFacade();
        await ordinary.connect();
        await ordinary.disconnect();
        expect(selectedPolicies).toEqual(['latest-wins', 'none']);
    });

    it('shares one bounded session observation owner across facades', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const sinks: ALDeliverySettlementSink[] = [];
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            sinks.push(options.deliverySettlements.ws);
            return runtime.middleware.middleware;
        });
        const first = createRallarFacade();
        const second = createRallarFacade();
        const firstHandle = await first.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
        const secondHandle = await second.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
        expect(runtime.initialiseMiddleware).toHaveBeenCalledTimes(1);
        sinks[0]({
            kind: 'acknowledgement',
            msgId: secondHandle.msgId,
            carrier: 'ws',
            atMs: Date.now(),
            mode: 'hop',
            confirmedHopPeerIds: ['second-hop'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['second-hop'],
            confirmedRecipientPeerIds: ['second-hop'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
        expect(secondHandle.lifecycle().state).toBe('acknowledged');
        sinks[0]({
            kind: 'acknowledgement',
            msgId: firstHandle.msgId,
            carrier: 'ws',
            atMs: Date.now(),
            mode: 'hop',
            confirmedHopPeerIds: ['first-hop'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['first-hop'],
            confirmedRecipientPeerIds: ['first-hop'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
        expect(firstHandle.lifecycle().state).toBe('acknowledged');
        await first.disconnect();
        await second.disconnect();
    });

    it('retains a disconnected facade waiter when a sibling completes its durable work', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const first = createRallarFacade();
        const second = createRallarFacade();
        const handle = await first.messages.ws.send({
            scope: 'all',
            typeId: 'app.ready',
            payload: true,
            ack: 'receiver'
        });
        await handle.wait({ until: ['queued'] });
        const completion = handle.wait({ until: ['acknowledged'] });
        await first.disconnect();
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            options.deliverySettlements.ws({
                kind: 'acknowledgement',
                msgId: handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                mode: 'hop',
                confirmedHopPeerIds: ['sibling-hop'],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['sibling-hop'],
                confirmedRecipientPeerIds: ['sibling-hop'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
            return runtime.middleware.middleware;
        });
        await second.connect();
        expect(handle.lifecycle().state).toBe('acknowledged');
        expect((await completion).lifecycle.evidence.confirmedHopPeerIds).toEqual(['sibling-hop']);
        await first.connect();
        expect(handle.lifecycle().evidence.confirmedHopPeerIds).toEqual(['sibling-hop']);
        await first.disconnect();
        await second.disconnect();
    });

    it.each(['logout', 'replacement'] as const)(
        'invalidates a sibling queued handle immediately on session %s',
        async (termination) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const first = createRallarFacade();
            const second = createRallarFacade();
            await first.connect();
            const handle = await second.messages.ws.send({
                scope: 'all',
                typeId: 'app.ready',
                payload: true,
                ack: 'receiver'
            });
            await handle.wait({ until: ['queued'] });
            const completion = handle.wait();
            if (termination === 'logout') {
                vi.spyOn(authApi, 'logoutFromApi').mockResolvedValue({ loggedOut: true });
                await first.auth.logout();
            }
            else {
                runtime.readSession.mockReturnValue({ ...runtime.middleware.session, sessionId: 'replacement-session' });
                await first.connect();
            }
            expect(handle.lifecycle().state).toBe('unobservable');
            expect((await completion).lifecycle.state).toBe('unobservable');
            await first.disconnect();
            await second.disconnect();
        }
    );

    it('opens carrier observation before reconnect initialization and fences detached sinks', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        let oldSink: ALDeliverySettlementSink | undefined;
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            oldSink = options.deliverySettlements.ws;
            return runtime.middleware.middleware;
        });
        const handle = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
        await handle.wait({ until: ['queued'] });
        await facade.disconnect();
        oldSink?.({
            kind: 'acknowledgement',
            msgId: handle.msgId,
            carrier: 'ws',
            atMs: Date.now(),
            mode: 'hop',
            confirmedHopPeerIds: ['stale'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['stale'],
            confirmedRecipientPeerIds: ['stale'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
        expect(handle.lifecycle().state).toBe('queued');
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            options.deliverySettlements.ws({
                kind: 'acknowledgement',
                msgId: handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                mode: 'hop',
                confirmedHopPeerIds: ['current'],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['current'],
                confirmedRecipientPeerIds: ['current'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
            expect(handle.lifecycle().state).toBe('acknowledged');
            return runtime.middleware.middleware;
        });
        await facade.connect();
        expect(handle.lifecycle().evidence.confirmedHopPeerIds).toEqual(['current']);
        await facade.disconnect();
    });

    it('fences another facade\'s pending admission while retaining its next-epoch observation', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const first = createRallarFacade();
        const second = createRallarFacade();
        await first.connect();
        const admission = Promise.withResolvers<ALOutboundEnqueueResult>();
        let result: ALOutboundEnqueueResult | undefined;
        const originalEnqueue = runtime.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent;
        runtime.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async (message) => {
            result = { verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }, message, entries: [] };
            return admission.promise;
        };
        const handle = await second.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true });
        await first.disconnect();
        if (!result) {
            throw new Error('Expected pending carrier admission');
        }
        admission.resolve(result);
        await admission.promise;
        await Promise.resolve();
        expect(handle.lifecycle().state).toBe('submitted');
        runtime.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = originalEnqueue;
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            options.deliverySettlements.ws({
                kind: 'acknowledgement',
                msgId: handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                mode: 'hop',
                confirmedHopPeerIds: ['current'],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['current'],
                confirmedRecipientPeerIds: ['current'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
            return runtime.middleware.middleware;
        });
        await first.connect();
        expect(handle.lifecycle().state).toBe('acknowledged');
        await first.disconnect();
        await second.disconnect();
    });

    it('fences failed initialization and registers again before retry initialization', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const handle = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
        await handle.wait({ until: ['queued'] });
        await facade.disconnect();
        let failedSink: ALDeliverySettlementSink | undefined;
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            failedSink = options.deliverySettlements.ws;
            throw new Error('connect failed');
        });
        await expect(facade.connect()).rejects.toThrow('connect failed');
        failedSink?.({
            kind: 'acknowledgement',
            msgId: handle.msgId,
            carrier: 'ws',
            atMs: Date.now(),
            mode: 'hop',
            confirmedHopPeerIds: ['failed'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['failed'],
            confirmedRecipientPeerIds: ['failed'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
        expect(handle.lifecycle().state).toBe('queued');
        runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
            options.deliverySettlements.ws({
                kind: 'acknowledgement',
                msgId: handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                mode: 'hop',
                confirmedHopPeerIds: ['retry'],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['retry'],
                confirmedRecipientPeerIds: ['retry'],
                unconfirmedRecipientPeerIds: [],
                complete: true
            });
            return runtime.middleware.middleware;
        });
        await facade.connect();
        expect(handle.lifecycle().evidence.confirmedHopPeerIds).toEqual(['retry']);
        await facade.disconnect();
    });

    it('releases observations when connect discovers a replacement auth session', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const handle = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
        await handle.wait({ until: ['queued'] });
        runtime.readSession.mockReturnValue({ ...runtime.middleware.session, sessionId: 'replacement-session' });
        await facade.connect();
        expect(handle.lifecycle().state).toBe('unobservable');
        await facade.disconnect();
    });

    it('cancels both carrier owners and releases pending observations when the session ends', async () => {
        const cancellations: string[] = [];
        runtime.middleware.middleware.rtcRxStreamer.cancelOutbox = (msgId) => {
            cancellations.push(`rtc:${msgId}`);
            return 'cancelled';
        };
        runtime.middleware.middleware.webSocketQueueBox.cancelOutbox = (msgId) => {
            cancellations.push(`ws:${msgId}`);
            return 'cancelled';
        };
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const cancelled = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true });
        cancelled.cancel();
        expect(cancelled.lifecycle().state).toBe('cancelled');
        expect(cancellations.sort()).toEqual([`rtc:${cancelled.msgId}`, `ws:${cancelled.msgId}`]);
        const pending = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true });
        vi.spyOn(authApi, 'logoutFromApi').mockResolvedValue({ loggedOut: true });
        await facade.auth.logout();
        expect((await pending.wait()).lifecycle.state).toBe('unobservable');
    });

    it('completes facade creation before later setup and connect use the composed ports', async () => {
        let facadeConstructionCompleted = false;
        runtime.readSession.mockImplementation(() => {
            if (!facadeConstructionCompleted) {
                throw new Error('Session dependency was used before facade construction completed.');
            }
            return runtime.middleware.session;
        });
        runtime.initialiseMiddleware.mockImplementation(async () => {
            if (!facadeConstructionCompleted) {
                throw new Error('Transport dependency was used before facade construction completed.');
            }
            return runtime.middleware.middleware;
        });
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        facadeConstructionCompleted = true;

        await facade.setup({
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'construction-test',
            start: {
                restoreSession: false,
                connect: false,
                refreshRooms: false,
                refreshPeople: false
            }
        });
        await facade.connect();

        expect(facade.status()).toBe('connected');
        expect(facade.isConnected()).toBe(true);
        await facade.disconnect();
    });
});
