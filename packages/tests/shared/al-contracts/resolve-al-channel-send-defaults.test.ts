import { describe, expect, it } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import {
    AL_CHANNEL_PURPOSES,
    AL_CHANNEL_SEND_DEFAULTS,
    resolveALChannelSendDefaults
} from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('the channel purpose table (D2, D52)', () => {
    it('makes both purposes at-least-once, receipted, volatile and 30 s', () => {
        expect(AL_CHANNEL_PURPOSES).toEqual(['command', 'notification']);
        expect(AL_CHANNEL_SEND_DEFAULTS).toEqual({
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
        });
    });

    it('keeps the channel declared durability and drops the receipt where no logical audience exists', () => {
        expect(
            resolveALChannelSendDefaults({
                purpose: 'command',
                durability: 'local-outbox',
                hasLogicalAudience: true
            })
        )
            .toEqual({
                reliability: 'at-least-once',
                ack: 'receiver',
                ttlMs: 30_000,
                durability: 'local-outbox'
            });
        expect(
            resolveALChannelSendDefaults({
                purpose: 'notification',
                durability: undefined,
                hasLogicalAudience: false
            })
        )
            .toEqual({
                reliability: 'at-least-once',
                ack: 'none',
                ttlMs: 30_000,
                durability: 'volatile'
            });
    });

    it.each(AL_CHANNEL_PURPOSES)(
        'normalizes a %s default to receiver with a 2 s ACK timeout and three receipt retries',
        (purpose) => {
            const defaults = resolveALChannelSendDefaults({
                purpose,
                durability: undefined,
                hasLogicalAudience: true
            });
            const message = newALMulticastMessage(
                'self',
                { topicId: 'chat', resourceId: `purpose-${purpose}`, contextId: 'room' },
                ROOM,
                'chat.message.v1',
                { text: purpose },
                {
                    reliability: defaults.reliability,
                    ack: defaults.ack,
                    ttlMs: defaults.ttlMs,
                    qos: { durability: { algo: defaults.durability } }
                }
            );

            const { effective } = normalizeALQosPolicy(message);

            expect(effective.ack).toEqual({ algo: 'receiver', opts: { timeoutMs: 2_000 } });
            expect(effective.retry).toEqual({ algo: 'exp-backoff', opts: { maxAttempts: 3 } });
            expect(effective.durability.algo).toBe('volatile');
        }
    );
});
