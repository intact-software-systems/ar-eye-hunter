import {
    BROWSER_RTT_HEARTBEAT_TTL_MS,
    toBrowserRttHeartbeatMessage
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';

describe('Browser middleware RTT heartbeat messages', () => {
    it('uses short-lived versioned AL messages for RTT observations', () => {
        const first = toBrowserRttHeartbeatMessage('session-a', rtt(1));
        const second = toBrowserRttHeartbeatMessage('session-a', rtt(2));

        expect(first.id.senderId).toBe('session-a');
        expect(first.route.topicId).toBe(AppTopics.rtt);
        expect(first.route.resourceId).toBe('1');
        expect(second.route.resourceId).toBe('2');
        expect(first.route.contextId).toBe(second.route.contextId);
        expect(first.payload.typeId).toBe(AppTopics.rtt);
        expect(first.constraints?.expiresAtMs).toBe(first.id.ts + BROWSER_RTT_HEARTBEAT_TTL_MS);
        expect(second.constraints?.expiresAtMs).toBe(second.id.ts + BROWSER_RTT_HEARTBEAT_TTL_MS);
    });
});

function rtt(version: number): RttMeasurementInfo {
    return {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 25 + version,
        createdAtEpochMs: 1_000 + version,
        version
    };
}
