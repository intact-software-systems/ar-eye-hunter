import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    newALMulticastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { isALOutboundCanonicalReplacement } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { isALOutboundCanonicalRowFrozenBy } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const CREATED_AT = Temporal.Instant.from('2026-10-13T00:00:00.123456789Z');

const HELD = newALMulticastMessage(
    'origin',
    newALRoute('room.chat', 'room-1', 'message-1'),
    { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' },
    'chat.message.v1',
    {},
    { ttlMs: 30_000 }
);
const FROZEN = toALFrozenMulticastMessage(HELD, { recipientPeerIds: ['b', 'c'], snapshotVersion: 4 });
/** A retained request of a keyed frame, and its admission: the record its read stamped and the proof it was signed with. */
const REQUESTED: ALMessage = { ...FROZEN, ordering: { orderingKey: 'feed', epoch: 1, seq: 2 } };
const ADMITTED: ALMessage = {
    ...REQUESTED,
    ordering: { ...REQUESTED.ordering, priorSeqByRecipient: { c: 0 } },
    proof: { alg: 'ES256', keyId: 'k'.repeat(43), signature: 'Q'.repeat(86) }
};

describe('the replacement of a canonical row', () => {
    it('replaces a held row by the plan that froze its audience', () => {
        expect(isALOutboundCanonicalReplacement(false, toEntry(HELD), toEntry(FROZEN))).toBe(true);
    });

    it('refuses a malformed retained row as corruption when the candidate freezes an audience', () => {
        expect(() => isALOutboundCanonicalReplacement(false, toMalformedEntry(), toEntry(FROZEN)))
            .toThrow(ALAdmissionCorruptionError);
    });

    it('replaces a retained request by its replay, whose admission added a sequence-keyed record and a proof', () => {
        expect(isALOutboundCanonicalReplacement(true, toRetainedEntry(REQUESTED), toEntry(ADMITTED))).toBe(true);
    });

    it('keeps a retained request against a candidate that changes more than its admission adds, or outside a replay', () => {
        const changed = { ...ADMITTED, payload: { ...ADMITTED.payload, resource: '{"changed":true}' } };

        expect(isALOutboundCanonicalReplacement(true, toRetainedEntry(REQUESTED), toEntry(changed))).toBe(false);
        expect(isALOutboundCanonicalReplacement(false, toRetainedEntry(REQUESTED), toEntry(ADMITTED))).toBe(false);
    });

    it('answers no replacement, reading no retained row, for a candidate that neither freezes nor mints', () => {
        expect(isALOutboundCanonicalReplacement(false, toMalformedEntry(), toEntry(HELD))).toBe(false);
    });
});

describe('a canonical row frozen by a plan', () => {
    it('is the held row whose audience the plan froze', () => {
        expect(isALOutboundCanonicalRowFrozenBy(toEntry(HELD), FROZEN)).toBe(true);
    });

    it('refuses a malformed canonical row as corruption when the plan freezes an audience', () => {
        expect(() => isALOutboundCanonicalRowFrozenBy(toMalformedEntry(), FROZEN)).toThrow(ALAdmissionCorruptionError);
    });
});

function toEntry(message: ALMessage): ResourceEntry {
    return QueueBoxUtilities.toResourceEntryFromMsg(message, 'AL_OUTBOUND_MESSAGE', CREATED_AT);
}

/** The row a commit that lost its fence retained: the request, completed, as a replay finds it. */
function toRetainedEntry(message: ALMessage): ResourceEntry {
    return { ...toEntry(message), status: EntityStatus.COMPLETED };
}

function toMalformedEntry(): ResourceEntry {
    return { ...toEntry(HELD), resource: JSON.stringify({ malformed: true }) };
}
