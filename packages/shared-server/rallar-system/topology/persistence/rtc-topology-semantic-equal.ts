import { compareRtcTopologyIdentifiers } from './rtc-topology-identifiers.ts';

/** Object-key-order neutral, array-order preserving equality for RTC values. */
export function rtcTopologySemanticEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => rtcTopologySemanticEqual(value, right[index]));
    }
    if (!isRecord(left) || !isRecord(right)) {
        return false;
    }
    const leftKeys = Object.keys(left).sort(compareRtcTopologyIdentifiers);
    const rightKeys = Object.keys(right).sort(compareRtcTopologyIdentifiers);
    return leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) =>
            key === rightKeys[index] &&
            rtcTopologySemanticEqual(left[key], right[key])
        );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
