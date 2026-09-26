import type { RallarMessageSendBase } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo, ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import {
    resolveALChannelSendDefaults,
    type ALChannelPurpose
} from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

/** A typed channel's send policy, copied once from its validated definition when the channel is created. */
export interface BrowserTypedChannelPolicy {
    readonly purpose: ALChannelPurpose;
    readonly durability: ALDurabilityAlgo | undefined;
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

/** Every send option wins over the channel's purpose; the purpose only fills what the send left out. */
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
        ack: send.ack ?? defaults.ack,
        qos: { ...send.qos, durability: send.qos?.durability ?? { algo: defaults.durability } }
    };
}
