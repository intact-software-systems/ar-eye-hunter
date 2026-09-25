import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALTargets
} from '@shared/al-contracts/al-contract.ts';
import { DEFAULT_AL_QOS_CAPABILITIES, normalizeALQosPolicy, type ALQosCapabilities } from '@shared/al-contracts/al-policy.ts';
import {
    toALReceiverAckNormalizationInput,
    validateALAckSupport
} from '@shared/al-contracts/validate-al-ack-support.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const route = { topicId: 'chat', contextId: 'room', resourceId: 'message' };
const receiverCapabilities: ALQosCapabilities = {
    ...DEFAULT_AL_QOS_CAPABILITIES,
    supportedAck: [...DEFAULT_AL_QOS_CAPABILITIES.supportedAck, 'receiver']
};
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
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: worldTargets, capabilities: receiverCapabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws world targets' }]);
    });

    it('admits receiver on room and unicast targets where the capabilities declare it', () => {
        for (const targets of [roomBroadcastTargets, roomMulticastTargets, { mode: 'unicast', toPeerId: 'peer' } as const]) {
            expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets, capabilities: receiverCapabilities })).toEqual([]);
        }
    });

    it('refuses receiver wherever the capabilities do not declare it, naming the carrier and targets', () => {
        expect(DEFAULT_AL_QOS_CAPABILITIES.supportedAck).not.toContain('receiver');
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'rtc', targets: roomMulticastTargets, capabilities: DEFAULT_AL_QOS_CAPABILITIES }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for rtc multicast targets' }]);
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: undefined, capabilities: receiverCapabilities }))
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

    it('declares receiver for a carrier that tracks it, while a provider that names its own ack set keeps it', () => {
        const message = {
            ...newALUnicastMessage('sender', route, 'peer', 'chat.v1', {}),
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        } as const;
        const declared = normalizeALQosPolicy(message, toALReceiverAckNormalizationInput({}));
        const narrowed = normalizeALQosPolicy(
            message,
            toALReceiverAckNormalizationInput({ capabilities: { supportedAck: ['none', 'hop'] } })
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
