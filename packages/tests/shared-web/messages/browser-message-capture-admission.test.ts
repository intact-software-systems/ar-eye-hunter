import {
    describe,
    expect,
    it
} from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

describe('required capture at final message admission', () => {
    it.each([['session', 'clock'], ['middleware', 'clock'], ['session', 'handle'], ['middleware', 'handle']] as const)(
        'reports %s replacement by the %s callback before admission, preserving the captured receipt',
        (replaced, phase) => {
            const queued: string[] = [];
            const context = createDefaultApiMiddlewareTestDouble({
                middleware: {
                    webSocketQueueBox: {
                        enqueueOutboxIfAbsent: async (message) => {
                            queued.push(message.id.msgId);
                            return { verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
                        }
                    }
                }
            });
            const auth = { current: context.session };
            let current = context;
            const replace = (): void => {
                if (replaced === 'session') {
                    auth.current = { ...context.session, sessionId: 'replacement' };
                }
                else {
                    current = createDefaultApiMiddlewareTestDouble();
                }
            };
            const receipt = createBrowserRtcCapture({
                configuration: { mode: 'off', origin: 'run' },
                connectionId: { status: 'observed', value: 'original' },
                record: undefined,
                nowEpochMs: () => 1
            }).receipt;
            const deliveries = new BrowserRallarDeliveryRegistry({
                nowMs: () => {
                    if (phase === 'handle') {
                        replace();
                    }
                    return 1;
                },
                retainTerminalMs: 100,
                maxEntries: 8,
                cancel: () => {}
            });
            const feed = new BrowserDeliverySettlements();
            const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
                readMiddleware: () => current,
                readRtcCaptureReceipt: () => receipt,
                deliverySettlements: feed
            }, () => auth.current);
            sessionDeliveries.beginSession(context.session);
            feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
            const dispatch = new BrowserRallarMessageDispatch({
                deliveries,
                sessionDeliveries,
                nowMs: () => {
                    if (phase === 'clock') {
                        replace();
                    }
                    return 1;
                }
            });
            const message = newALBroadcastMessage(
                context.session.sessionId,
                { topicId: 'app.capture', contextId: 'all', resourceId: 'one' },
                'all',
                'test',
                {},
                { ttlMs: 100 }
            );
            const rtcCapture = sessionDeliveries.readRtcCapture(context);
            const handle = deliveries.open(message, 'ws', rtcCapture);
            expect(() =>
                dispatch.send({
                    context,
                    message,
                    carrier: 'ws',
                    requestedConfiguration: { mode: 'off', origin: 'run' },
                    rtcCapture,
                    canFallback: false,
                    payloadIssues: [],
                    onStorageUnavailable: 'refuse'
                })
            ).toThrow(RallarRtcCaptureUnverifiedError);
            expect(queued).toEqual([]);
            expect(handle.rtcCapture()).toEqual({ status: 'observed', value: receipt });
        }
    );
    it('keeps an ordinary admission callback exception as the existing failed handle outcome', async () => {
        const queued: string[] = [];
        const context = createDefaultApiMiddlewareTestDouble({
            middleware: {
                webSocketQueueBox: {
                    enqueueOutboxIfAbsent: async (message) => {
                        queued.push(message.id.msgId);
                        return { verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
                    }
                }
            }
        });
        const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: () => 1, retainTerminalMs: 100, maxEntries: 8, cancel: () => {} });
        const feed = new BrowserDeliverySettlements();
        const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
            readMiddleware: () => context,
            readRtcCaptureReceipt: () => undefined,
            deliverySettlements: feed
        }, () => context.session);
        sessionDeliveries.beginSession(context.session);
        feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
        let clockFailed = false;
        const dispatch = new BrowserRallarMessageDispatch({
            deliveries,
            sessionDeliveries,
            nowMs: () => {
                if (!clockFailed) {
                    clockFailed = true;
                    throw new Error('admission clock failed');
                }
                return 1;
            }
        });
        const message = newALBroadcastMessage(context.session.sessionId, { topicId: 'app.capture', contextId: 'all', resourceId: 'one' }, 'all', 'test', {}, {
            ttlMs: 100
        });
        const handle = deliveries.open(message, 'ws');
        expect(() =>
            dispatch.send({
                context,
                message,
                carrier: 'ws',
                requestedConfiguration: undefined,
                rtcCapture: { status: 'unavailable', reason: 'absent' },
                canFallback: false,
                payloadIssues: [],
                onStorageUnavailable: 'refuse'
            })
        ).not.toThrow();
        expect((await handle.wait()).lifecycle).toMatchObject({ state: 'failed', evidence: { reason: 'admission clock failed' } });
        expect(queued).toEqual([]);
    });
    it.each(['permitted', 'middleware', 'session', 'epoch', 'omitted'] as const)(
        'keeps congestion fallback bound to its original envelope and capture after diagnostic reentry (%s)',
        async (reentry) => {
            const attempts: ALMessage[] = [];
            const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
            const configuration = { mode: 'signaling', origin: 'run' } as const;
            const receipt = createBrowserRtcCapture({
                configuration,
                connectionId: { status: 'observed', value: 'congested-original' },
                record: () => {},
                nowEpochMs: () => 1
            }).receipt;
            expect(receipt.application).toEqual({ status: 'applied', mode: 'signaling' });
            const feed = new BrowserDeliverySettlements();
            const initial = createDefaultApiMiddlewareTestDouble({
                middleware: {
                    webSocketQueueBox: {
                        enqueueOutboxIfAbsent: async (message) => {
                            attempts.push(message);
                            return { verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
                        }
                    }
                }
            });
            const owner = { middleware: initial, session: initial.session };
            const context = createDefaultApiMiddlewareTestDouble({
                middleware: {
                    rtcRxStreamer: {
                        enqueueOutboxIfAbsent: async (message) => ({
                            verdict: { kind: 'refused', reason: 'congested', detail: 'RTC backpressure' },
                            message,
                            entries: [],
                            trackedReceiptAlgo: 'none'
                        })
                    },
                    webSocketQueueBox: {
                        enqueueOutboxIfAbsent: async (message) => {
                            attempts.push(message);
                            return { verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 }, message, entries: [], trackedReceiptAlgo: 'none' };
                        }
                    },
                    outboundDiagnostics: (event) => {
                        diagnostics.push(event);
                        if (reentry === 'middleware') {
                            owner.middleware = initial;
                        }
                        if (reentry === 'session') {
                            owner.session = { ...owner.session, sessionId: 'replacement' };
                        }
                        if (reentry === 'epoch') {
                            feed.close();
                        }
                    }
                }
            });
            owner.middleware = context;
            owner.session = context.session;
            const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: () => 1, retainTerminalMs: 100, maxEntries: 8, cancel: () => {} });
            const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
                readMiddleware: () => owner.middleware,
                readRtcCaptureReceipt: () => receipt,
                deliverySettlements: feed
            }, () => owner.session);
            sessionDeliveries.beginSession(context.session);
            feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
            const dispatch = new BrowserRallarMessageDispatch({ deliveries, sessionDeliveries, nowMs: () => 1 });
            const message = newALMulticastMessage(
                context.session.sessionId,
                { topicId: 'app.capture', contextId: 'room', resourceId: 'congested' },
                { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                'test',
                {},
                { ttlMs: 100, minSnapshotVersion: 9, rosterVersion: 4 }
            );
            const rtcCapture = sessionDeliveries.readRtcCapture(context);
            const handle = deliveries.open(message, 'rtc', rtcCapture);
            dispatch.send({
                context,
                message,
                carrier: 'rtc',
                requestedConfiguration: reentry === 'omitted' ? undefined : configuration,
                rtcCapture,
                canFallback: true,
                payloadIssues: [],
                onStorageUnavailable: 'refuse'
            });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(diagnostics).toEqual([
                { kind: 'congestion', carrier: 'rtc', cause: 'backpressured', action: 'hand-over', priority: 0, msgId: handle.msgId }
            ]);
            expect(handle.rtcCapture()).toEqual({ status: 'observed', value: receipt });
            expect(handle.msgId).toBe(message.id.msgId);
            expect(handle.lifecycle().expiresAtMs).toBe(message.constraints?.expiresAtMs);
            if (reentry === 'permitted' || reentry === 'omitted') {
                expect(attempts).toEqual([message]);
                expect(attempts[0]).toBe(message);
                expect(attempts[0].targets).toMatchObject({ minSnapshotVersion: 9, rosterVersion: 4 });
                expect(handle.lifecycle().state).toBe('queued');
            }
            else {
                expect(attempts).toEqual([]);
                expect(handle.lifecycle().state).not.toBe('queued');
            }
        }
    );
});
