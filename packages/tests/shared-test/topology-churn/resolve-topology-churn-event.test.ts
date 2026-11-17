import {
    resolveTopologyChurnEvent,
    type TopologyChurnPresentMember
} from '@shared-test/black-box-runner/topology-churn/resolve-topology-churn-event.ts';
import { describe, expect, it } from 'vitest';

const CREATOR: TopologyChurnPresentMember = { memberId: 'creator', presentSinceEpochMs: 1_000 };

function toMember(memberId: string, presentSinceEpochMs: number): TopologyChurnPresentMember {
    return { memberId, presentSinceEpochMs };
}

describe('resolveTopologyChurnEvent', () => {
    it('answers a join for a join action', () => {
        const presentMembers = [CREATOR, toMember('a', 2_000), toMember('b', 3_000)];

        expect(resolveTopologyChurnEvent({ action: { kind: 'join' }, presentMembers, creatorMemberId: 'creator' }))
            .toEqual({ kind: 'join' });
    });

    it('lets the member present longest leave, never the creator who has been present longer still', () => {
        const presentMembers = [toMember('late', 9_000), CREATOR, toMember('early', 2_000), toMember('middle', 5_000)];

        expect(resolveTopologyChurnEvent({ action: { kind: 'leave' }, presentMembers, creatorMemberId: 'creator' }))
            .toEqual({ kind: 'leave', memberId: 'early' });
    });

    it('breaks a tie between equally old members by their order among the present members', () => {
        const presentMembers = [CREATOR, toMember('first', 2_000), toMember('second', 2_000)];

        expect(resolveTopologyChurnEvent({ action: { kind: 'leave' }, presentMembers, creatorMemberId: 'creator' }))
            .toEqual({ kind: 'leave', memberId: 'first' });
    });

    it('skips a leave when only the creator is present', () => {
        expect(
            resolveTopologyChurnEvent({ action: { kind: 'leave' }, presentMembers: [CREATOR], creatorMemberId: 'creator' })
        ).toEqual({ kind: 'skip' });
    });
});
