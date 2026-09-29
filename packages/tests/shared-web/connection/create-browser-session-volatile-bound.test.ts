import { describe, expect, it } from 'vitest';

import { createBrowserSessionVolatileBound } from '@shared-web/browser/connection/create-browser-session-volatile-bound.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    type ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

const NOW_MS = 1_700_000_000_000;
const MESSAGE = newALUnicastMessage(
    'self',
    { topicId: 'chat', resourceId: 'planned', contextId: 'room' },
    'peer',
    'chat.message.v1',
    { text: 'planned' },
    { ttlMs: 30_000 }
);

function toAdmission(msgId: string, bytes = 1): ALVolatileSessionBudget.Admission {
    return { msgId, bytes, deadlineAtMs: NOW_MS + 30_000, nowMs: NOW_MS };
}

describe('the session volatile bound the middleware builds (C3, C13)', () => {
    it('bounds a session by D74\'s two constants when the composition gives no reader', () => {
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: undefined,
            qosProvider: undefined,
            nowMs: () => NOW_MS
        });

        expect(
            bound.budget.tryAdmit(toAdmission('too-large', AL_VOLATILE_SESSION_MAX_BYTES + 1)).left
                ?.limit
        )
            .toBe('bytes');
        for (let index = 0; index < AL_VOLATILE_SESSION_MAX_ADMISSIONS; index += 1) {
            expect(bound.budget.tryAdmit(toAdmission(`sent-${index}`)).left).toBeUndefined();
        }
        expect(bound.budget.tryAdmit(toAdmission('one-too-many')).left?.limit).toBe('admissions');
    });

    it('bounds the session by the limits its reader answered first', () => {
        const answers = [{ maxAdmissions: 2, maxBytes: 4_096 }];
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: () => answers.shift() ?? { maxAdmissions: 1_000, maxBytes: 4_096 },
            qosProvider: undefined,
            nowMs: () => NOW_MS
        });

        bound.budget.tryAdmit(toAdmission('first'));
        bound.budget.tryAdmit(toAdmission('second'));

        // A second read would answer 1 000 admissions and admit the third.
        expect(bound.budget.tryAdmit(toAdmission('third')).left?.limit).toBe('admissions');
    });

    it('hands the carriers a provider over the same budget that keeps the application\'s answers', () => {
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: () => ({ maxAdmissions: 1, maxBytes: 4_096 }),
            qosProvider: { liveForMessage: () => ({ hasAlternateRoute: true }) },
            nowMs: () => NOW_MS
        });

        expect(bound.qosProvider.liveForMessage?.(MESSAGE, { direction: 'inbound' }))
            .toEqual({ hasAlternateRoute: true });
        bound.budget.record(toAdmission('received'));
        expect(bound.qosProvider.liveForMessage?.(MESSAGE, { direction: 'inbound' }))
            .toEqual({ hasAlternateRoute: true, overloaded: true });
    });
});
