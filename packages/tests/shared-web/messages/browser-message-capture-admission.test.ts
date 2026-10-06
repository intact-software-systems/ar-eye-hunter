import { describe, expect, it } from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import { newALBroadcastMessage } from '@shared/al-contracts/al-contract.ts';

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
});
