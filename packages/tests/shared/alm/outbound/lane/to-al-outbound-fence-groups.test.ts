import { describe, expect, it } from 'vitest';

import {
    toALOutboundFenceGroups,
    type ALOutboundFenceGroupMember
} from '@shared/alm/outbound/lane/to-al-outbound-fence-groups.ts';

/** A decided member named `name`, of `senderId`, whose bundle read `expectedVersion` and fences the sender or not. */
interface NamedFenceGroupMember extends ALOutboundFenceGroupMember {
    readonly name: string;
}

function toMember(
    name: string,
    fencesSender: boolean,
    expectedVersion: number | undefined,
    senderId = 'server'
): NamedFenceGroupMember {
    return { name, bundle: { senderId, expectedVersion, fencesSender } };
}

function toNames(groups: readonly (readonly NamedFenceGroupMember[])[] | undefined): readonly (readonly string[])[] | undefined {
    return groups?.map((group) => group.map((member) => member.name));
}

describe('one sender\'s decided bundles as the groups one write each can commit', () => {
    it('keeps bundles that all fence the sender on one version as one group', () => {
        // Pins a uniform sender-fenced batch staying one write.
        const members = [toMember('first', true, 3), toMember('second', true, 3), toMember('third', true, 3)];

        expect(toNames(toALOutboundFenceGroups(members))).toEqual([['first', 'second', 'third']]);
    });

    it('keeps bundles that fence no sender as one group, whatever version each read', () => {
        // Pins a group of own-message fences asked for no agreed sender version, since none of its writes checks one.
        const members = [toMember('first', false, undefined), toMember('second', false, 2), toMember('third', false, 5)];

        expect(toNames(toALOutboundFenceGroups(members))).toEqual([['first', 'second', 'third']]);
    });

    it('splits a mixed group in two, the sender-fenced first, each member once and in its given order', () => {
        // Pins a mixed batch committing as two writes instead of being refused and committed member by member.
        const members = [
            toMember('receipt-1', false, 4),
            toMember('event-1', true, 4),
            toMember('receipt-2', false, undefined),
            toMember('event-2', true, 4),
            toMember('receipt-3', false, 4)
        ];

        const groups = toALOutboundFenceGroups(members);

        expect(toNames(groups)).toEqual([['event-1', 'event-2'], ['receipt-1', 'receipt-2', 'receipt-3']]);
        expect(groups!.flat()).toHaveLength(members.length);
        expect(new Set(groups!.flat())).toEqual(new Set(members));
    });

    it('answers nothing when the sender-fenced bundles read different versions', () => {
        // Pins a group whose reads disagree on the sender version committing alone, as no one write can fence both.
        const members = [toMember('receipt', false, 1), toMember('event-1', true, 1), toMember('event-2', true, 2)];

        expect(toALOutboundFenceGroups(members)).toBeUndefined();
    });

    it('answers nothing for bundles of two senders', () => {
        // Pins a group that names two senders committing alone, as one write fences one sender.
        const members = [toMember('first', false, undefined, 'server'), toMember('second', false, undefined, 'origin')];

        expect(toALOutboundFenceGroups(members)).toBeUndefined();
    });
});
