import { describe, expect, it } from 'vitest';

import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import {
    summarizeLiveRtcSendResult,
    summarizeNackSendResult,
    toFailedControlResult
} from '../../../tests/playwright/rallar-black-box/live-rtc-failure-diagnostics.ts';

describe('live RTC failure diagnostics', () => {
    it('uses only result value for successful command facts', () => {
        const result: LiveRtcControlClient.Result = {
            commandId: 'successful-send',
            ok: true,
            result: {
                value: {
                    message: {
                        state: 'accepted',
                        handleId: 'successful-message',
                        reason: 'not-yet-in-sync',
                        submitted: true,
                        enqueued: false,
                        backpressured: false,
                        attempts: 1,
                        confirmedHopPeerIds: ['peer'],
                        unconfirmedHopPeerIds: []
                    }
                }
            },
            error: { details: { message: { state: 'failed', reason: 'secret' } } }
        };
        expect(summarizeLiveRtcSendResult(result)).toEqual({
            ok: true,
            state: 'accepted',
            reason: 'not-yet-in-sync',
            messageIdPresent: true,
            submitted: true,
            enqueued: false,
            backpressured: false,
            attempts: 1,
            confirmedHopCount: 1,
            unconfirmedHopCount: 0
        });
    });

    it('uses only error details for contradictory failed command facts', () => {
        const result: LiveRtcControlClient.Result & { ok: false; } = {
            commandId: 'failed-send',
            ok: false,
            result: { value: { message: { state: 'accepted', reason: 'secret' } } },
            error: {
                details: {
                    message: {
                        state: 'failed',
                        handleId: 'failed-message',
                        reason: 'secret producer text',
                        submitted: true,
                        enqueued: false,
                        attempts: 0,
                        backpressured: false,
                        confirmedHopPeerIds: [],
                        unconfirmedHopPeerIds: ['secret-peer']
                    }
                }
            }
        };
        const summary = summarizeLiveRtcSendResult(result);
        const failure = toFailedControlResult(result);
        expect(summary).toEqual({
            ok: false,
            state: 'failed',
            reason: 'other',
            messageIdPresent: true,
            submitted: true,
            enqueued: false,
            backpressured: false,
            attempts: 0,
            confirmedHopCount: 0,
            unconfirmedHopCount: 1
        });
        expect(failure).toMatchObject({ state: 'failed', reason: 'other', attempts: 0 });
        expect(JSON.stringify({ summary, failure })).not.toContain('secret');
        expect(JSON.stringify({ summary, failure })).not.toContain('failed-message');
    });

    it.each([undefined, null, 'secret', [{ credential: 'secret' }]])(
        'maps malformed failed details to bounded missing facts: %s',
        (details) => {
            const result: LiveRtcControlClient.Result & { ok: false; } = {
                commandId: 'malformed',
                ok: false,
                error: details === undefined ? {} : { details }
            };
            expect(summarizeLiveRtcSendResult(result)).toEqual({
                ok: false,
                state: 'missing',
                reason: null,
                messageIdPresent: false,
                submitted: null,
                enqueued: null,
                backpressured: null,
                attempts: null,
                confirmedHopCount: null,
                unconfirmedHopCount: null
            });
            expect(toFailedControlResult(result)).toMatchObject({ state: null, reason: null });
        }
    );

    it('retains only hop counts, bounded state and probe identity comparison', () => {
        const result: LiveRtcControlClient.Result & { ok: false; } = {
            commandId: 'failed-nack',
            ok: false,
            error: {
                details: {
                    message: {
                        state: 'secret-state',
                        handleId: 'probe-message',
                        confirmedHopPeerIds: Array.from({ length: 25 }, () => 'secret-peer'),
                        payload: { credential: 'secret' }
                    }
                }
            }
        };
        const summary = summarizeNackSendResult(result, 'probe-message');
        expect(summary).toMatchObject({
            state: 'other',
            confirmedHopCount: 25,
            messageIdPresent: true,
            messageIdMatchesProbe: true
        });
        expect(toFailedControlResult(result)).toMatchObject({ state: 'other' });
        expect(JSON.stringify(summary)).not.toContain('probe-message');
        expect(JSON.stringify({ summary, failed: toFailedControlResult(result) })).not.toContain('secret');
    });
});
