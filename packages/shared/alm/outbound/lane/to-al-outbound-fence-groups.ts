import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';

/** What the grouping reads of one decided bundle. */
export interface ALOutboundFenceGroupMember {
    readonly bundle: Pick<ALOutboundCommitBundle<never>, 'senderId' | 'expectedVersion' | 'fencesSender'>;
}

/**
 * One sender's decided bundles as the groups one write each can commit: those that fence the sender version, which
 * must have read one version of it, then those that fence their own message alone. An empty group is left out, and
 * each member keeps its place within its group. When the sender-fenced ones read different versions they are left
 * out, so each commits alone, and those that fence their own message are the one group. `undefined` when the bundles
 * name more than one sender, or when no group is left: every member then commits alone.
 */
export function toALOutboundFenceGroups<TMember extends ALOutboundFenceGroupMember>(
    members: readonly TMember[]
): readonly (readonly TMember[])[] | undefined {
    const senderId = members[0]?.bundle.senderId;
    if (members.some(({ bundle }) => bundle.senderId !== senderId)) {
        return undefined;
    }
    const fenced = members.filter(({ bundle }) => bundle.fencesSender);
    const expectedVersion = fenced[0]?.bundle.expectedVersion;
    const agreed = fenced.every(({ bundle }) => bundle.expectedVersion === expectedVersion);
    const unfenced = members.filter(({ bundle }) => !bundle.fencesSender);
    const groups = [agreed ? fenced : [], unfenced].filter((group) => group.length > 0);
    return groups.length === 0 ? undefined : groups;
}
