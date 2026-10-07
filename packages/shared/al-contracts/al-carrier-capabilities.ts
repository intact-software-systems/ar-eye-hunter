import type { ALQosCapabilities, ALQosInputProvider } from './al-policy.ts';
import { DEFAULT_AL_QOS_CAPABILITIES } from './normalize-al-qos-policy.ts';

/** What one carrier can track, installed by its composition root under the application's QoS provider. */
export interface ALCarrierCapabilities {
    readonly name: 'ws-client' | 'rtc-overlay' | 'ws-server';
    readonly qos: ALQosCapabilities;
}

const AL_RECEIVER_TRACKING_QOS_CAPABILITIES: ALQosCapabilities = {
    ...DEFAULT_AL_QOS_CAPABILITIES,
    supportedAck: ['none', 'hop', 'subtree', 'receiver', 'leader']
};

export const AL_WS_CLIENT_CAPABILITIES: ALCarrierCapabilities = {
    name: 'ws-client',
    qos: AL_RECEIVER_TRACKING_QOS_CAPABILITIES
};

export const AL_RTC_OVERLAY_CAPABILITIES: ALCarrierCapabilities = {
    name: 'rtc-overlay',
    qos: AL_RECEIVER_TRACKING_QOS_CAPABILITIES
};

export const AL_WS_SERVER_CAPABILITIES: ALCarrierCapabilities = {
    name: 'ws-server',
    qos: AL_RECEIVER_TRACKING_QOS_CAPABILITIES
};

/** The application's capabilities override the carrier's, so a provider that names its own ack set keeps it. */
export function toALCarrierQosInputProvider(
    capabilities: ALCarrierCapabilities,
    provider: ALQosInputProvider | undefined
): ALQosInputProvider {
    return {
        defaultsForMessage: (msg, context) => provider?.defaultsForMessage?.(msg, context),
        capabilitiesForMessage: (msg, context) => ({
            ...capabilities.qos,
            ...provider?.capabilitiesForMessage?.(msg, context)
        }),
        authorizationForMessage: (msg, context) => provider?.authorizationForMessage?.(msg, context),
        liveForMessage: (msg, context) => provider?.liveForMessage?.(msg, context)
    };
}
