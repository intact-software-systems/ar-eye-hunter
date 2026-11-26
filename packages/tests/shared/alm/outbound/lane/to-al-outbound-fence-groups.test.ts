import { describe, expect, it } from 'vitest';

import {
    toALOutboundFenceGroups,
    type ALOutboundFenceGroupMember
} from '@shared/alm/outbound/lane/to-al-outbound-fence-groups.ts';

/** A decided member named `name`, whose bundle read `expectedVersion` and fences the sender or not. */
interface NamedFenceGroupMember extends ALOutboundFenceGroupMember {
    readonly name: string;
}

interface FenceGroupMemberInput {
    readonly name: string;
    readonly fencesSender: boolean;
    readonly expectedVersion: number | undefined;
    /** The bundle's sender; `server` when the case names none. */
    readonly senderId?: string;
}

function toMember({ name, fencesSender, expectedVersion, senderId = 'server' }: FenceGroupMemberInput): NamedFenceGroupMember {
    return { name, bundle: { senderId, expectedVersion, fencesSender } };
}

/** A member that fences the sender version it read as `expectedVersion`. */
function toFenced(name: string, expectedVersion: number | undefined): NamedFenceGroupMember {
    return toMember({ name, fencesSender: true, expectedVersion });
}

/** A member that fences its own message alone, whatever sender version it read. */
function toUnfenced(name: string, expectedVersion: number | undefined): NamedFenceGroupMember {
    return toMember({ name, fencesSender: false, expectedVersion });
}

function toNames(groups: readonly (readonly NamedFenceGroupMember[])[] | undefined): readonly (readonly string[])[] | undefined {
    return groups?.map((group) => group.map((member) => member.name));
}

describe('one sender\'s decided bundles as the groups one write each can commit', () => {
    it('keeps bundles that all fence the sender on one version as one group', () => {
        // Pins a uniform sender-fenced batch staying one write.
        const members = [toFenced('first', 3), toFenced('second', 3), toFenced('third', 3)];

        expect(toNames(toALOutboundFenceGroups(members))).toEqual([['first', 'second', 'third']]);
    });

    it('keeps bundles that fence no sender as one group, whatever version each read', () => {
        // Pins a group of own-message fences asked for no agreed sender version, since none of its writes checks one.
        const members = [toUnfenced('first', undefined), toUnfenced('second', 2), toUnfenced('third', 5)];

        expect(toNames(toALOutboundFenceGroups(members))).toEqual([['first', 'second', 'third']]);
    });

    it('splits a mixed group in two, the sender-fenced first, each member once and in its given order', () => {
        // Pins a mixed batch committing as two writes instead of being refused and committed member by member.
        const members = [
            toUnfenced('receipt-1', 4),
            toFenced('event-1', 4),
            toUnfenced('receipt-2', undefined),
            toFenced('event-2', 4),
            toUnfenced('receipt-3', 4)
        ];

        const groups = toALOutboundFenceGroups(members);

        expect(toNames(groups)).toEqual([['event-1', 'event-2'], ['receipt-1', 'receipt-2', 'receipt-3']]);
        expect(groups!.flat()).toHaveLength(members.length);
        expect(new Set(groups!.flat())).toEqual(new Set(members));
    });

    it('keeps the bundles that fence no sender as one group when the sender-fenced ones read different versions', () => {
        // Pins the members that need no agreed sender version committing alone because the sender-fenced ones disagree,
        // or a disagreeing sender-fenced member joining a group write, which no one write can fence for both versions.
        const members = [toUnfenced('receipt-1', 1), toFenced('event-1', 1), toUnfenced('receipt-2', undefined), toFenced('event-2', 2)];

        expect(toNames(toALOutboundFenceGroups(members))).toEqual([['receipt-1', 'receipt-2']]);
    });

    it('answers nothing when the sender-fenced bundles read different versions and none fences its message alone', () => {
        // Pins a batch whose reads disagree on the sender version committing alone, as no one write can fence both.
        const members = [toFenced('event-1', 1), toFenced('event-2', 2)];

        expect(toALOutboundFenceGroups(members)).toBeUndefined();
    });

    it('answers nothing for bundles of two senders', () => {
        // Pins a group that names two senders committing alone, as one write fences one sender.
        const members = [
            toMember({ name: 'first', fencesSender: false, expectedVersion: undefined, senderId: 'server' }),
            toMember({ name: 'second', fencesSender: false, expectedVersion: undefined, senderId: 'origin' })
        ];

        expect(toALOutboundFenceGroups(members)).toBeUndefined();
    });
});
