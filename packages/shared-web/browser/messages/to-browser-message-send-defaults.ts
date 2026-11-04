import { isExclusiveSendInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageSendBase,
    RallarRoomAudienceInput,
    RallarStorageUnavailablePolicy,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendStrategy,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo, ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import {
    resolveALChannelSendDefaults,
    type ALChannelPurpose
} from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

/** A typed channel's send policy, copied once from its validated definition when the channel is created. */
export interface BrowserTypedChannelPolicy {
    readonly purpose: ALChannelPurpose;
    readonly access: RallarTypedMessageChannelDefinition['access'];
    readonly durability: ALDurabilityAlgo | undefined;
    readonly onStorageUnavailable: RallarStorageUnavailablePolicy;
    /** Defined exactly on a `live` channel: the policy its sends are staged under. */
    readonly publication: ALPublicationPolicy | undefined;
}

export interface BrowserMessageSendDefaults {
    readonly ttlMs: number;
    readonly reliability: 'best-effort' | 'at-least-once';
    readonly ack: ALAckMode;
    readonly qos: ALQosPolicyRequest | undefined;
}

export interface ToBrowserMessageSendDefaultsInput {
    readonly send: Pick<RallarMessageSendBase<never>, 'ttlMs' | 'reliability' | 'ack' | 'qos'>;
    /** Undefined for a lane send (`messages.rtc.send`, `messages.ws.send`), which keeps today's defaults. */
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly hasLogicalAudience: boolean;
    readonly laneTtlMs: number;
}

/** A lane send (`messages.rtc.send`, `messages.ws.send`) names no channel, so storage it cannot use refuses it. */
export function resolveBrowserStorageUnavailablePolicy(
    channel: BrowserTypedChannelPolicy | undefined
): RallarStorageUnavailablePolicy {
    return channel?.onStorageUnavailable ?? 'refuse';
}

export interface BrowserWsOnlySendInput {
    readonly send:
        & Pick<RallarMessageSendBase<never>, 'ownership' | 'qos'>
        & RallarRoomAudienceInput
        & Pick<RallarWsSendInput<never>, 'peerId'>;
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly strategy: RallarTypedMessageSendStrategy;
}

/**
 * Only the WS server arbitrates a claim, so RTC carries no exclusive send. RTC carries a granted publication only
 * as a signed room multicast, the one a strategy that starts on RTC sends there, with or without a receipt.
 */
export function isBrowserWsOnlySend(input: BrowserWsOnlySendInput): boolean {
    if (isExclusiveSendInput(input.send)) {
        return true;
    }
    return resolveBrowserChannelAccess(input.channel) === 'granted' && !isBrowserRtcGrantedPublication(input);
}

function isBrowserRtcGrantedPublication(input: BrowserWsOnlySendInput): boolean {
    return (input.strategy === 'rtc' || input.strategy === 'rtc-with-ws-fallback') &&
        isBrowserRoomMulticastSend(input.send);
}

/** A send no carrier turns into a broadcast: no peer, no world or principal scope and no narrowed audience. */
function isBrowserRoomMulticastSend(send: BrowserWsOnlySendInput['send']): boolean {
    return send.peerId === undefined && send.scope !== 'world' && send.scope !== 'principal' &&
        !isRallarRoomNarrowedAudience(send);
}

/** A room send that names its exclusions, its principal or its fixed list, which both carriers send as a broadcast. */
export function isRallarRoomNarrowedAudience(audience: Omit<RallarRoomAudienceInput, 'scope'>): boolean {
    return audience.exceptPeerIds !== undefined || audience.principalId !== undefined ||
        audience.recipientPeerIds !== undefined;
}

/** A lane send names no channel, so every active member of its room may publish it. */
export function resolveBrowserChannelAccess(
    channel: BrowserTypedChannelPolicy | undefined
): RallarTypedMessageChannelDefinition['access'] {
    return channel?.access ?? 'members';
}

/**
 * Every send option wins over the channel's purpose; the purpose only fills what the send left out, except that
 * a best-effort send asks for no receipt unless it names an ack.
 */
export function toBrowserMessageSendDefaults(
    input: ToBrowserMessageSendDefaultsInput
): BrowserMessageSendDefaults {
    const { send, channel } = input;
    if (channel === undefined) {
        return {
            ttlMs: send.ttlMs ?? input.laneTtlMs,
            reliability: send.reliability ?? 'at-least-once',
            ack: send.ack ?? 'none',
            qos: send.qos
        };
    }
    const defaults = resolveALChannelSendDefaults({
        purpose: channel.purpose,
        durability: channel.durability,
        hasLogicalAudience: input.hasLogicalAudience
    });
    return {
        ttlMs: send.ttlMs ?? defaults.ttlMs,
        reliability: send.reliability ?? defaults.reliability,
        ack: send.ack ?? (send.reliability === 'best-effort' ? 'none' : defaults.ack),
        qos: { ...send.qos, durability: send.qos?.durability ?? { algo: defaults.durability } }
    };
}
