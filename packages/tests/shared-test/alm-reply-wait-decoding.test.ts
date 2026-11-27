import type { RallarMessagePayload, RallarMessageReplyOutcome } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { describe, expect, it } from 'vitest';
import { decodeAlmMessagesAwaitReplyResultValue } from '../../shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';

/** Keyed by every status the product resolves without a reply, so a new one fails to compile here and gets a row. */
const STATUSES_WITHOUT_A_REPLY: Readonly<Record<Exclude<RallarMessageReplyOutcome<RallarMessagePayload>['status'], 'replied'>, true>> = {
    timeout: true,
    aborted: true,
    undelivered: true,
    unanswerable: true
};

describe('the reply wait outcome a page states to the lane', () => {
    it.each(Object.keys(STATUSES_WITHOUT_A_REPLY))('reads a wait that ended %s as the page stated it, with no reply', (status) => {
        const stated = { handleId: 'handle-1', status, state: 'acknowledged', corrId: 'msg-1' };

        expect(decodeAlmMessagesAwaitReplyResultValue(stated)).toEqual(stated);
    });
});
