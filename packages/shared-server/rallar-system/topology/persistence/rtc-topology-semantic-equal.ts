import { compareRtcTopologyIdentifiers } from './rtc-topology-identifiers.ts';

type RtcTopologySemanticValue = null | boolean | number | string | object;

/** Object-key-order neutral, array-order preserving equality for RTC values. */
export function rtcTopologySemanticEqual(
    left: RtcTopologySemanticValue | undefined,
    right: RtcTopologySemanticValue | undefined
): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => rtcTopologySemanticEqual(value, right[index]));
    }
    if (!isRtcTopologyRecord(left) || !isRtcTopologyRecord(right)) {
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

function isRtcTopologyRecord(
    value: RtcTopologySemanticValue | undefined
): value is Readonly<Record<string, RtcTopologySemanticValue | undefined>> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
