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
    it('maps each request name onto its ack algorithm: receiver and all-logical-recipients are one logical algorithm, group-leader is leader', () => {
        const requested = (ack: ALAckMode) =>
            normalizeALQosPolicy(newALMulticastMessage('sender', route, room, 'chat.v1', {}, { reliability: 'at-least-once', ack }))
                .requested.ack?.algo;

        expect(requested('receiver')).toBe('receiver');
        expect(requested('all-logical-recipients')).toBe('receiver');
        expect(requested('group-leader')).toBe('leader');
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

    it('admits receiver on a principal broadcast in a room and on a listed room broadcast, over both carriers', () => {
        const principalRef = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };
        const principalInRoom: ALTargets = { mode: 'broadcast', scope: 'principal', groupRef: room, principalRef };
        const listedRoom: ALTargets = { ...roomBroadcastTargets, recipientPeerIds: ['b'] };

        for (const targets of [principalInRoom, listedRoom]) {
            expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets, capabilities: wsCapabilities })).toEqual([]);
            expect(validateALAckSupport({ algo: 'receiver', carrier: 'rtc', targets, capabilities: rtcCapabilities })).toEqual([]);
        }
    });

    it('refuses receiver on a principal broadcast that names no room and on an all broadcast', () => {
        const principalRef = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };

        expect(validateALAckSupport({
            algo: 'receiver',
            carrier: 'ws',
            targets: { mode: 'broadcast', scope: 'principal', principalRef },
            capabilities: wsCapabilities
        })).toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws principal targets' }]);
        expect(validateALAckSupport({
            algo: 'receiver',
            carrier: 'ws',
            targets: { mode: 'broadcast', scope: 'all' },
            capabilities: wsCapabilities
        })).toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws all targets' }]);
    });

    it('admits receiver on a WS unicast that names its room and refuses one that names none (D53, C2)', () => {
        const roomless: ALTargets = { mode: 'unicast', toPeerId: 'peer' };
        const inRoom: ALTargets = { mode: 'unicast', toPeerId: 'peer', groupRef: room };

        expect(
            validateALAckSupport({
                algo: 'receiver',
                carrier: 'ws',
                targets: roomless,
                capabilities: wsCapabilities
            })
        )
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws unicast targets' }]);
        expect(
            validateALAckSupport({
                algo: 'receiver',
                carrier: 'ws',
                targets: inRoom,
                capabilities: wsCapabilities
            })
        )
            .toEqual([]);
        expect(
            validateALAckSupport({
                algo: 'receiver',
                carrier: 'rtc',
                targets: roomless,
                capabilities: rtcCapabilities
            })
        )
            .toEqual([]);
    });

    it('refuses receiver wherever the capabilities do not declare it, naming the carrier and targets', () => {
        expect(DEFAULT_AL_QOS_CAPABILITIES.supportedAck).not.toContain('receiver');
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'rtc', targets: roomMulticastTargets, capabilities: DEFAULT_AL_QOS_CAPABILITIES }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for rtc multicast targets' }]);
        expect(validateALAckSupport({ algo: 'receiver', carrier: 'ws', targets: undefined, capabilities: wsCapabilities }))
            .toEqual([{ aspect: 'ack', detail: 'ack receiver is unsupported for ws untargeted targets' }]);
    });

    it('admits leader on a room multicast, a room broadcast, a principal broadcast in its room and a listed room broadcast, over both carriers', () => {
        const principalRef = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };
        const principalInRoom: ALTargets = { mode: 'broadcast', scope: 'principal', groupRef: room, principalRef };
        const listedRoom: ALTargets = { ...roomBroadcastTargets, recipientPeerIds: ['b'] };

        for (const targets of [roomMulticastTargets, roomBroadcastTargets, principalInRoom, listedRoom]) {
            expect(validateALAckSupport({ algo: 'leader', carrier: 'ws', targets, capabilities: wsCapabilities })).toEqual([]);
            expect(validateALAckSupport({ algo: 'leader', carrier: 'rtc', targets, capabilities: rtcCapabilities })).toEqual([]);
        }
    });

    it.each<{ name: string; targets: ALTargets; }>([
        { name: 'unicast', targets: { mode: 'unicast', toPeerId: 'peer', groupRef: room } },
        { name: 'world', targets: worldTargets },
        { name: 'all', targets: { mode: 'broadcast', scope: 'all' } }
    ])('refuses leader on a $name target, which has no room leader, with one issue per carrier', ({ name, targets }) => {
        expect(validateALAckSupport({ algo: 'leader', carrier: 'ws', targets, capabilities: wsCapabilities }))
            .toEqual([{ aspect: 'ack', detail: `ack leader is unsupported for ws ${name} targets` }]);
        expect(validateALAckSupport({ algo: 'leader', carrier: 'rtc', targets, capabilities: rtcCapabilities }))
            .toEqual([{ aspect: 'ack', detail: `ack leader is unsupported for rtc ${name} targets` }]);
    });

    it('keeps an unsupported leader request as requested instead of downgrading it', () => {
        const message = newALMulticastMessage('sender', route, room, 'chat.v1', {}, { reliability: 'at-least-once', ack: 'group-leader' });
        const normalized = normalizeALQosPolicy(message, { capabilities: { supportedAck: ['none', 'hop'] } });

        expect(normalized.effective.ack.algo).toBe('leader');
        expect(normalized.notes.filter((note) => note.aspect === 'ack')).toEqual([]);
        expect(validateALAckSupport({
            algo: normalized.effective.ack.algo,
            carrier: 'rtc',
            targets: message.targets,
            capabilities: normalized.capabilities
        })).toEqual([{ aspect: 'ack', detail: 'ack leader is unsupported for rtc multicast targets' }]);
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
            qos: { ack: { algo: 'subtree' } }
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
