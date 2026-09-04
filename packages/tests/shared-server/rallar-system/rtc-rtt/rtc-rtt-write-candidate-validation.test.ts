import { validateRtcRttWriteCandidate } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-write-candidate.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-validation-primitives.ts';
import { describe, expect, it } from 'vitest';

import {
    createMutableRttWriteCandidate,
    rttWriteCandidateCorruptions
} from './persistence/rtc-rtt-persistence-test-fixtures.ts';

describe('RTC RTT write-candidate validation', () => {
    it.each(rttWriteCandidateCorruptions)(
        'rejects $label at the pure validation boundary',
        ({ corrupt }) => {
            const malformed = corrupt(createMutableRttWriteCandidate());

            expect(() =>
                Reflect.apply(validateRtcRttWriteCandidate, undefined, [
                    malformed,
                    2 + RTC_RTT_MUTATION_RETENTION_MS
                ])
            ).toThrow(TypeError);
        }
    );
});
