import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RTT_REPORTING_DEGREE_LIMIT,
    normalizeRttReportingDegreeLimit,
    selectRttReportingPeers,
} from '@shared/rtc/rtt-reporting-policy.ts';

describe('RTT reporting policy', () => {
    it('defaults to the topology degree limit fallback', () => {
        expect(DEFAULT_RTT_REPORTING_DEGREE_LIMIT).toBe(5);
        expect(normalizeRttReportingDegreeLimit(undefined, 4)).toBe(4);
        expect(normalizeRttReportingDegreeLimit(3, 5)).toBe(3);
        expect(normalizeRttReportingDegreeLimit(0, 5)).toBe(5);
        expect(normalizeRttReportingDegreeLimit(1.5, 5)).toBe(5);
    });

    it('selects overlay next hops before bootstrap candidates', () => {
        const result = selectRttReportingPeers({
            localSessionId: 'self',
            degreeLimit: 3,
            overlayNextHopSessionIds: ['peer-c', 'peer-a', 'self'],
            activePeerSessionIds: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
            groupKey: 'app:workspace:room',
        });

        expect(result.selectedPeerIds).toEqual(['peer-a', 'peer-c', 'peer-d']);
        expect(result.degreeLimit).toBe(3);
    });

    it('keeps bootstrap selection deterministic and capped', () => {
        const input = {
            localSessionId: 'self',
            degreeLimit: 2,
            activePeerSessionIds: ['peer-d', 'peer-a', 'peer-c', 'self', 'peer-b'],
            groupKey: 'app:workspace:room',
        };

        expect(selectRttReportingPeers(input).selectedPeerIds)
            .toEqual(selectRttReportingPeers(input).selectedPeerIds);
        expect(selectRttReportingPeers(input).selectedPeerIds).toHaveLength(2);
        expect(selectRttReportingPeers(input).selectedPeerIds).not.toContain('self');
    });
});
