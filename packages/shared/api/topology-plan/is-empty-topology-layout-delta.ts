import type { TopologyLayoutDelta } from './rtc-topology-plan-record.ts';

export function isEmptyTopologyLayoutDelta(delta: TopologyLayoutDelta): boolean {
    return Object.values(delta).every((count) => count === 0);
}
