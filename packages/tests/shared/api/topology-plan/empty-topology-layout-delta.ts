import type { TopologyLayoutDelta } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';

export const EMPTY_TOPOLOGY_LAYOUT_DELTA: TopologyLayoutDelta = {
    joinedSessionCount: 0,
    leftSessionCount: 0,
    changedSessionCount: 0,
    reroutedSessionCount: 0,
    acceptingSessionCount: 0,
    maxJoinerEdgesPerSession: 0
};
