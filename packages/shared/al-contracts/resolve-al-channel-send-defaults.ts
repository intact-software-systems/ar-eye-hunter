import type { ALAckMode } from './al-contract.ts';
import type { ALDurabilityAlgo } from './al-policy.ts';

/** What a typed channel carries; the purpose fixes the channel's send defaults (D2, D52). */
export type ALChannelPurpose = 'command' | 'notification';

export const AL_CHANNEL_PURPOSES: readonly ALChannelPurpose[] = ['command', 'notification'];

/**
 * The envelope fields a purpose decides. The 2 s ACK timeout and the three receipt retries of the
 * roadmap's table are the at-least-once normalization defaults these fields select.
 */
export interface ALChannelSendDefaults {
    readonly reliability: 'at-least-once';
    readonly ack: ALAckMode;
    readonly ttlMs: number;
    readonly durability: ALDurabilityAlgo;
}

/** `receiver` asks the addressed receiver; `all-logical-recipients` the frozen audience -- one algorithm (D41). */
export const AL_CHANNEL_SEND_DEFAULTS: Readonly<Record<ALChannelPurpose, ALChannelSendDefaults>> = {
    command: {
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 30_000,
        durability: 'volatile'
    },
    notification: {
        reliability: 'at-least-once',
        ack: 'all-logical-recipients',
        ttlMs: 30_000,
        durability: 'volatile'
    }
};

export interface ResolveALChannelSendDefaultsInput {
    readonly purpose: ALChannelPurpose;
    /** The channel's declared durability; absent, the purpose's. */
    readonly durability: ALDurabilityAlgo | undefined;
    /** A room multicast or room broadcast names a logical audience; a world or all broadcast does not (A1). */
    readonly hasLogicalAudience: boolean;
}

export function resolveALChannelSendDefaults(
    input: ResolveALChannelSendDefaultsInput
): ALChannelSendDefaults {
    const defaults = AL_CHANNEL_SEND_DEFAULTS[input.purpose];
    return {
        ...defaults,
        ack: input.hasLogicalAudience ? defaults.ack : 'none',
        durability: input.durability ?? defaults.durability
    };
}
