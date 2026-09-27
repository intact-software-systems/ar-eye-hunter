import { describe, expect, it } from 'vitest';

import {
    AL_RTC_OVERLAY_CAPABILITIES,
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import {
    DEFAULT_AL_QOS_CAPABILITIES,
    normalizeALQosPolicy,
    resolveALQosNormalizationInput
} from '@shared/al-contracts/al-policy.ts';
import { validateALAckSupport } from '@shared/al-contracts/validate-al-ack-support.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const route = { topicId: 'chat', contextId: 'room', resourceId: 'message' };
const wsCapabilities = AL_WS_CLIENT_CAPABILITIES.qos;
const rtcCapabilities = AL_RTC_OVERLAY_CAPABILITIES.qos;
const worldTargets: ALTargets = { mode: 'broadcast', scope: 'world' };
const roomBroadcastTargets: ALTargets = { mode: 'broadcast', scope: 'room', groupRef: room };
const roomMulticastTargets: ALTargets = { mode: 'multicast', groupRef: room };

describe('validateALAckSupport', () => {
    it('maps each request name onto its ack algorithm: receiver and all-logical-recipients are one logical algorithm', () => {
        const requested = (ack: ALAckMode) =>
            normalizeALQosPolicy(newALMulticastMessage('sender', route, room, 'chat.v1', {}, { reliability: 'at-least-once', ack }))
                .requested.ack?.algo;

        expect(requested('receiver')).toBe('receiver');
        expect(requested('all-logical-recipients')).toBe('receiver');
        expect(requested('group-leader')).toBe('subtree');
        expect(requested('none')).toBe('none');
    });

    it('refuses receiver on world targets even where the capabilities declare it', () => {
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: worldTargets, capabilities: wsCapabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws world targets' }]);
    });

    it('admits receiver on room targets where the capabilities declare it', () => {
        for (const targets of [roomBroadcastTargets, roomMulticastTargets]) {
            expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets, capabilities: wsCapabilities })).toEqual([]);
        }
    });

    it('refuses receiver on a WS unicast, whose receiver ACK no relay carries back to the origin (D42)', () => {
        const unicast: ALTargets = { mode: 'unicast', toPeerId: 'peer' };

        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: unicast, capabilities: wsCapabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws unicast targets' }]);
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'rtc', targets: unicast, capabilities: rtcCapabilities }))
            .toEqual([]);
    });

    it('refuses receiver wherever the capabilities do not declare it, naming the carrier and targets', () => {
        expect(DEFAULT_AL_QOS_CAPABILITIES.supportedAck).not.toContain('receiver');
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'rtc', targets: roomMulticastTargets, capabilities: DEFAULT_AL_QOS_CAPABILITIES }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for rtc multicast targets' }]);
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: undefined, capabilities: wsCapabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws untargeted targets' }]);
    });

    it('leaves the hop, subtree and none algorithms to the capabilities alone', () => {
        for (const algo of ['none', 'hop', 'subtree'] as const) {
            expect(validateALAckSupport({ algo, carrier: 'rtc', targets: worldTargets, capabilities: DEFAULT_AL_QOS_CAPABILITIES })).toEqual([]);
        }
    });

    it('keeps an unsupported receiver request as requested instead of downgrading it', () => {
        const message = newALBroadcastMessage('sender', route, 'world', 'chat.v1', {}, { reliability: 'at-least-once', ack: 'receiver' });
        const normalized = normalizeALQosPolicy(message);

        expect(normalized.effective.ack.algo).toBe('receiver');
        expect(normalized.notes.filter((note) => note.aspect === 'ack')).toEqual([]);
        expect(validateALAckSupport({
            algo: normalized.effective.ack.algo,
            carrier: 'ws',
            targets: message.targets,
            capabilities: normalized.capabilities
        })).toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws world targets' }]);
    });

    it('keeps a provider-defaulted receiver instead of downgrading it', () => {
        const message = { ...newALBroadcastMessage('sender', route, 'world', 'chat.v1', {}), delivery: undefined };
        const normalized = normalizeALQosPolicy(message, { defaults: { ack: { algo: 'receiver', opts: { timeoutMs: 250 } } } });

        expect(normalized.requested.ack).toBeUndefined();
        expect(normalized.effective.ack.algo).toBe('receiver');
    });

    it('declares receiver for a carrier that tracks it, while a provider that names its own ack set keeps it', () => {
        const message = {
            ...newALUnicastMessage('sender', route, 'peer', 'chat.v1', {}),
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        } as const;
        const context = { direction: 'outbound' } as const;
        const declared = normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(message, context, toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined))
        );
        const narrowed = normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(
                message,
                context,
                toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, { capabilitiesForMessage: () => ({ supportedAck: ['none', 'hop'] }) })
            )
        );

        expect(declared.capabilities.supportedAck).toContain('receiver');
        expect(narrowed.capabilities.supportedAck).toEqual(['none', 'hop']);
        expect(narrowed.effective.ack.algo).toBe('receiver');
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: message.targets, capabilities: narrowed.capabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws unicast targets' }]);
    });

    it('prefers receiver as the fallback only where the capabilities support it', () => {
        const message = newALMulticastMessage('sender', route, room, 'chat.v1', {}, {
            reliability: 'at-least-once',
            ack: 'group-leader'
        });
        const withReceiver = normalizeALQosPolicy(message, {
            capabilities: { supportedAck: ['none', 'receiver'] }
        });
        const withoutReceiver = normalizeALQosPolicy(message, {
            capabilities: { supportedAck: ['none'] }
        });

        expect(withReceiver.effective.ack.algo).toBe('receiver');
        expect(withoutReceiver.effective.ack.algo).toBe('none');
    });
});
