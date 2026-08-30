import {
    BROWSER_RTT_HEARTBEAT_TTL_MS,
    configureBrowserRtcPeerCreationPolicies,
    toBrowserRtcPeerCreationDecision,
    toBrowserRttHeartbeatMessage
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { WebRtcInboundPeerCreationPolicy, WebRtcOutboundDialPolicy } from '@shared/services/WebRtcConnectionService.ts';
import { QRtcSignalingType } from '@shared/webrtc/QRtcSignalingContracts.ts';
import { describe, expect, it, vi } from 'vitest';

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

describe('browser middleware RTC peer admission', () => {
    it('denies missing peers outside the lifecycle-selected layouts', () => {
        expect(toBrowserRtcPeerCreationDecision(false)).toEqual({
            decision: 'deny',
            reason: 'stage-layout-mismatch'
        });
        expect(toBrowserRtcPeerCreationDecision(true)).toEqual({
            decision: 'allow'
        });
    });

    it('uses the same admission for a lagging inbound offer and an outbound dial', () => {
        let inboundPolicy: WebRtcInboundPeerCreationPolicy | undefined;
        let outboundPolicy: WebRtcOutboundDialPolicy | undefined;
        const connectionService = {
            setInboundPeerCreationPolicy: vi.fn((policy) => {
                inboundPolicy = policy;
            }),
            setOutboundDialPolicy: vi.fn((policy) => {
                outboundPolicy = policy;
            })
        };
        const groupManager = {
            isPeerDialAllowedByAnyGroup: vi.fn((peerId: string) => peerId === 'peer-accepted')
        };
        configureBrowserRtcPeerCreationPolicies(
            connectionService as never,
            groupManager as never
        );

        expect(
            inboundPolicy?.({
                peerId: 'peer-planned',
                signalType: QRtcSignalingType.Offer,
                message: {} as never
            })
        ).toEqual({
            decision: 'deny',
            reason: 'stage-layout-mismatch'
        });
        expect(outboundPolicy?.({ peerId: 'peer-planned' })).toEqual({
            decision: 'deny',
            reason: 'stage-layout-mismatch'
        });
        expect(
            inboundPolicy?.({
                peerId: 'peer-accepted',
                signalType: QRtcSignalingType.Offer,
                message: {} as never
            })
        ).toEqual({ decision: 'allow' });
        expect(outboundPolicy?.({ peerId: 'peer-accepted' })).toEqual({
            decision: 'allow'
        });
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
