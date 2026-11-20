import { describe, expect, it } from 'vitest';

import { computeALOutboundAttemptDeadline } from '@shared/alm/outbound/attempt-deadline/compute-al-outbound-attempt-deadline.ts';

describe('an attempt deadline', () => {
    it.each([
        { attempts: 0, maxAttempts: 3, held: true, expected: { kind: 'wait', next: { attempts: 0, deadlineAtMs: 12_000 } } },
        { attempts: 3, maxAttempts: 3, held: true, expected: { kind: 'wait', next: { attempts: 3, deadlineAtMs: 12_000 } } },
        { attempts: 0, maxAttempts: 0, held: true, expected: { kind: 'wait', next: { attempts: 0, deadlineAtMs: 12_000 } } },
        { attempts: 2, maxAttempts: 3, held: false, expected: { kind: 'retry', next: { attempts: 3, deadlineAtMs: 12_000 } } },
        { attempts: 3, maxAttempts: 3, held: false, expected: { kind: 'exhausted' } },
        { attempts: 0, maxAttempts: 0, held: false, expected: { kind: 'exhausted' } }
    ])('at $attempts of $maxAttempts, held $held, answers $expected.kind', ({ attempts, maxAttempts, held, expected }) => {
        expect(computeALOutboundAttemptDeadline({
            budget: { timeoutMs: 2_000, maxAttempts, attempts },
            held,
            nowMs: 10_000
        })).toEqual(expected);
    });
});
