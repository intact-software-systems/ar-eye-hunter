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
                    status: 'sent',
                    message: {
                        status: 'accepted',
                        reason: 'not-yet-in-sync',
                        message: { id: { msgId: 'successful-message' } },
                        entries: [{ status: 'COMPLETED' }]
                    }
                }
            },
            error: {
                details: {
                    status: 'must-not-be-retained',
                    message: { status: 'failed', reason: 'must-not-be-retained' }
                }
            }
        };

        expect(summarizeLiveRtcSendResult(result)).toEqual({
            ok: true,
            runtimeStatus: 'sent',
            admissionStatus: 'accepted',
            reason: 'not-yet-in-sync',
            messageIdPresent: true,
            entryCount: 1,
            entryStatuses: ['COMPLETED']
        });
    });

    it('uses only error details for contradictory failed command facts', () => {
        const result: LiveRtcControlClient.Result & { ok: false; } = {
            commandId: 'failed-send',
            ok: false,
            result: {
                value: {
                    status: 'must-not-be-retained',
                    message: {
                        status: 'accepted',
                        reason: 'must-not-be-retained',
                        entries: [{ status: 'COMPLETED' }]
                    }
                }
            },
            error: {
                details: {
                    status: 'sent',
                    message: {
                        status: 'no-route',
                        reason: 'producer text must-not-be-retained',
                        message: {
                            id: { msgId: 'failed-message' },
                            payload: { credential: 'must-not-be-retained' }
                        },
                        entries: []
                    }
                }
            }
        };

        const sendSummary = summarizeLiveRtcSendResult(result);
        const failedResult = toFailedControlResult(result);
        expect(sendSummary).toEqual({
            ok: false,
            runtimeStatus: 'sent',
            admissionStatus: 'no-route',
            reason: 'other',
            messageIdPresent: true,
            entryCount: 0,
            entryStatuses: []
        });
        expect(failedResult).toMatchObject({
            runtimeStatus: 'sent',
            admissionStatus: 'no-route',
            reason: 'other',
            entryCount: 0,
            entryStatuses: []
        });
        expect(JSON.stringify({ sendSummary, failedResult }))
            .not.toContain('must-not-be-retained');
    });

    it.each([
        ['absent', undefined],
        ['null', null],
        ['string', 'must-not-be-retained'],
        ['array', [{ credential: 'must-not-be-retained' }]]
    ])('maps %s failed details to bounded missing facts', (_caseName, details) => {
        const result: LiveRtcControlClient.Result & { ok: false; } = {
            commandId: 'malformed-failed-send',
            ok: false,
            error: details === undefined ? {} : { details }
        };

        expect(summarizeLiveRtcSendResult(result)).toEqual({
            ok: false,
            runtimeStatus: 'missing',
            admissionStatus: 'missing',
            reason: 'missing',
            messageIdPresent: false,
            entryCount: 0,
            entryStatuses: []
        });
        expect(toFailedControlResult(result)).toMatchObject({
            runtimeStatus: null,
            admissionStatus: null,
            reason: null,
            entryCount: 0,
            entryStatuses: []
        });
    });

    it('counts all entries while retaining at most twenty classified statuses', () => {
        const result: LiveRtcControlClient.Result & { ok: false; } = {
            commandId: 'bounded-entry-statuses',
            ok: false,
            error: {
                details: {
                    message: {
                        entries: Array.from(
                            { length: 25 },
                            (_, index) => ({
                                status: index === 0 ? 'NEW' : 'must-not-be-retained'
                            })
                        )
                    }
                }
            }
        };

        const summary = summarizeLiveRtcSendResult(result);
        expect(summary?.entryCount).toBe(25);
        expect(summary?.entryStatuses).toEqual([
            'NEW',
            ...Array.from({ length: 19 }, () => 'other')
        ]);
        expect(JSON.stringify(summary)).not.toContain('must-not-be-retained');
    });

    it('classifies failed NACK message identity as presence and probe match only', () => {
        const result: LiveRtcControlClient.Result = {
            commandId: 'failed-nack-send',
            ok: false,
            error: {
                details: {
                    message: {
                        message: {
                            id: { msgId: 'probe-message' },
                            payload: { credential: 'must-not-be-retained' }
                        }
                    }
                }
            }
        };

        const summary = summarizeNackSendResult(result, 'probe-message');
        expect(summary).toMatchObject({
            messageIdPresent: true,
            messageIdMatchesProbe: true
        });
        expect(JSON.stringify(summary)).not.toContain('probe-message');
        expect(JSON.stringify(summary)).not.toContain('must-not-be-retained');
    });
});
