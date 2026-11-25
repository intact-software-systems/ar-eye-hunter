import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';

/** What the grouping reads of one decided bundle. */
export interface ALOutboundFenceGroupMember {
    readonly bundle: Pick<ALOutboundCommitBundle<never>, 'senderId' | 'expectedVersion' | 'fencesSender'>;
}

/**
 * One sender's decided bundles as the groups one write each can commit: those that fence the sender version, which
 * must have read one version of it, then those that fence their own message alone. An empty group is left out, and
 * each member keeps its place within its group. `undefined` when the bundles name more than one sender or the
 * sender-fenced ones read different versions: every member then commits alone.
 */
export function toALOutboundFenceGroups<TMember extends ALOutboundFenceGroupMember>(
    members: readonly TMember[]
): readonly (readonly TMember[])[] | undefined {
    const senderId = members[0]?.bundle.senderId;
    const fenced = members.filter(({ bundle }) => bundle.fencesSender);
    const expectedVersion = fenced[0]?.bundle.expectedVersion;
    if (
        members.some(({ bundle }) => bundle.senderId !== senderId) ||
        fenced.some(({ bundle }) => bundle.expectedVersion !== expectedVersion)
    ) {
        return undefined;
    }
    const unfenced = members.filter(({ bundle }) => !bundle.fencesSender);
    return [fenced, unfenced].filter((group) => group.length > 0);
}
