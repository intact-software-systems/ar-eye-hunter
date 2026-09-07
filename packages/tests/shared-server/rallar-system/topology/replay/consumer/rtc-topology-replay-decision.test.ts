import { describe, expect, it } from 'vitest';

import { decideRtcTopologyReplayEntry } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-decision.ts';
import { RtcTopologyDeliveryCorruptionError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-validation.ts';

import { createRtcTopologyReplayFixture } from './rtc-topology-replay-fixture.ts';

describe('decideRtcTopologyReplayEntry', () => {
    it('delivers the immutable publication when it is exactly current', () => {
        const fixture = createRtcTopologyReplayFixture();

        expect(decideRtcTopologyReplayEntry(fixture)).toEqual({
            status: 'deliver-publication',
            messages: fixture.outbox.map((page) => JSON.parse(page.resource))
        });
        expect(JSON.parse(fixture.outbox[0].resource).targets.recipientPeerIds).toEqual(['session-1']);
    });

    it.each([
        ['dominates', { version: 9 }],
        [
            'is incomparable with',
            { sourceGroupStateCausalRevision: { groupRevision: 5, presenceRevision: 5 } }
        ]
    ])('repairs from current state when current %s the historical state', (_label, update) => {
        const fixture = createRtcTopologyReplayFixture();
        const currentSnapshot = { ...fixture.currentSnapshot, ...update };

        expect(decideRtcTopologyReplayEntry({ ...fixture, currentSnapshot })).toEqual({
            status: 'deliver-current',
            currentSnapshot
        });
    });

    it('rejects a historical publication that appears to dominate current state', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry({
                ...fixture,
                currentSnapshot: { ...fixture.currentSnapshot, version: 7 }
            })
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('rejects equal causal identity with different current content', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry({
                ...fixture,
                currentSnapshot: { ...fixture.currentSnapshot, name: 'Conflicting name' }
            })
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('rejects a log key that differs from the immutable publication outbox', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry({
                ...fixture,
                entry: {
                    ...fixture.entry,
                    outboxKey: { ...fixture.entry.outboxKey, resourceId: 'wrong-resource' }
                }
            })
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('distinguishes missing unexpired references from a retention gap', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() => decideRtcTopologyReplayEntry({ ...fixture, publication: undefined })).toThrow(RtcTopologyDeliveryCorruptionError);
        expect(
            decideRtcTopologyReplayEntry({
                ...fixture,
                publication: undefined,
                databaseNowEpochMs: fixture.entry.retainUntilEpochMs
            })
        ).toEqual({ status: 'gap' });
        expect(
            decideRtcTopologyReplayEntry({
                ...fixture,
                databaseNowEpochMs: fixture.entry.retainUntilEpochMs
            })
        ).toEqual({ status: 'gap' });
    });
});
