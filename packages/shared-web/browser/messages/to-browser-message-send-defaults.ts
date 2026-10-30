import { isExclusiveSendInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type {
    RallarMessageSendBase,
    RallarStorageUnavailablePolicy,
    RallarTypedMessageChannelDefinition
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

/** Only the WS server arbitrates a claim and checks a publication grant, so RTC can carry neither send (D500). */
export function isBrowserWsOnlySend(
    send: Pick<RallarMessageSendBase<never>, 'ownership' | 'qos'>,
    channel: BrowserTypedChannelPolicy | undefined
): boolean {
    return isExclusiveSendInput(send) || resolveBrowserChannelAccess(channel) === 'granted';
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
