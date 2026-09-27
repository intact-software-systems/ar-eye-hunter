import { describe, expect, it } from 'vitest';

import {
    AL_RTC_OVERLAY_CAPABILITIES,
    AL_WS_CLIENT_CAPABILITIES,
    AL_WS_SERVER_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    DEFAULT_AL_QOS_CAPABILITIES,
    normalizeALQosPolicy,
    resolveALQosNormalizationInput
} from '@shared/al-contracts/al-policy.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const route = { topicId: 'chat', contextId: 'room', resourceId: 'message' };

describe('carrier capabilities', () => {
    it.each([AL_WS_CLIENT_CAPABILITIES, AL_RTC_OVERLAY_CAPABILITIES, AL_WS_SERVER_CAPABILITIES])(
        'declares receiver on $name beside the default algorithms',
        (capabilities) => {
            expect(capabilities.qos).toEqual({
                ...DEFAULT_AL_QOS_CAPABILITIES,
                supportedAck: ['none', 'hop', 'subtree', 'receiver']
            });
        }
    );

    it('installs the carrier capabilities under the application provider', () => {
        const provider = toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, {
            capabilitiesForMessage: () => ({ maxFanout: 4 })
        });

        expect(provider.capabilitiesForMessage?.({} as never, { direction: 'outbound' })).toEqual({
            ...AL_RTC_OVERLAY_CAPABILITIES.qos,
            maxFanout: 4
        });
    });

    it('keeps the application defaults, authorization and live state as its own', () => {
        const message = newALMulticastMessage('sender', route, room, 'chat.v1', {});
        const application = {
            defaultsForMessage: () => ({ ack: { algo: 'hop', opts: { timeoutMs: 250 } } }) as const,
            authorizationForMessage: () => ({ maxDurability: 'volatile' }) as const,
            liveForMessage: () => ({ overloaded: true })
        };
        const context = { direction: 'outbound' } as const;
        const installed = resolveALQosNormalizationInput(
            message,
            context,
            toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, application)
        );

        expect(installed).toEqual({
            ...resolveALQosNormalizationInput(message, context, application),
            capabilities: AL_WS_CLIENT_CAPABILITIES.qos
        });
    });

    // The WS client inbound path reads its carrier capabilities too: declaring receiver moves no effective policy.
    it.each(
        [
            { request: 'no ack', options: {} },
            { request: 'wire none', options: { ack: 'none' } },
            { request: 'wire group-leader', options: { ack: 'group-leader' } },
            { request: 'wire receiver', options: { ack: 'receiver' } },
            { request: 'wire all-logical-recipients', options: { ack: 'all-logical-recipients' } },
            { request: 'qos hop', options: { qos: { ack: { algo: 'hop' } } } },
            { request: 'qos subtree', options: { qos: { ack: { algo: 'subtree' } } } }
        ] as const
    )('normalizes an inbound $request to the policy the default capabilities give it', ({ options }) => {
        const message = newALMulticastMessage('sender', route, room, 'chat.v1', {}, { reliability: 'at-least-once', ...options });
        const context = { direction: 'inbound' } as const;
        const carried = normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(message, context, toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined))
        );

        expect(carried.effective).toEqual(normalizeALQosPolicy(message, resolveALQosNormalizationInput(message, context)).effective);
    });
});
