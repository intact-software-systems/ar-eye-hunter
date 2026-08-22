import { describe, expect, it } from 'vitest';
import { validatePersistedAppInboxResult } from '../../shared-test/black-box-runner/state-write-evidence/api-v1-state-write-result-evidence.ts';

describe('API-v1 persisted black-box result identity', () => {
    it('rejects a valid same-type auth result swapped across commands', () => {
        const swapped = {
            requestId: 'auth-second',
            clientId: 'client-second',
            username: 'second',
            displayName: null,
            registeredAtEpochMs: 2
        };
        expect(
            validatePersistedAppInboxResult({
                commandType: 'AUTH_USER_REGISTER',
                commandIds: ['auth-first'],
                resultStatus: 'COMPLETED',
                resultResource: JSON.stringify(swapped),
                requireAuthoritativeReceipt: true
            }).valid
        ).toBe(false);
        expect(
            validatePersistedAppInboxResult({
                commandType: 'AUTH_USER_REGISTER',
                commandIds: ['auth-second'],
                resultStatus: 'COMPLETED',
                resultResource: JSON.stringify(swapped),
                requireAuthoritativeReceipt: true
            }).valid
        ).toBe(true);
    });

    it('rejects a valid RTC RTT result swapped across commands', () => {
        const swapped = {
            requestId: 'rtt-second',
            accepted: true,
            reason: 'accepted',
            affectedGroups: [],
            updated: true
        };
        expect(
            validatePersistedAppInboxResult({
                commandType: 'RTC_RTT_SUBMIT',
                commandIds: ['rtt-first'],
                resultStatus: 'COMPLETED',
                resultResource: JSON.stringify(swapped),
                requireAuthoritativeReceipt: true
            }).valid
        ).toBe(false);
        expect(
            validatePersistedAppInboxResult({
                commandType: 'RTC_RTT_SUBMIT',
                commandIds: ['rtt-second'],
                resultStatus: 'COMPLETED',
                resultResource: JSON.stringify(swapped),
                requireAuthoritativeReceipt: true
            }).valid
        ).toBe(true);
    });
});
