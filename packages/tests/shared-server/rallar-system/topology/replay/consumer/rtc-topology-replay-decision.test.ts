import {
    describe,
    expect,
    it
} from 'vitest';

import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import {
    decideRtcTopologyReplayEntry,
    type RtcTopologyReplayEntryDecisionInput
} from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-decision.ts';
import { RtcTopologyDeliveryCorruptionError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-validation.ts';

import { createRtcTopologyReplayFixture, type RtcTopologyReplayFixture } from './rtc-topology-replay-fixture.ts';

describe('decideRtcTopologyReplayEntry', () => {
    it('delivers the immutable publication when it is exactly current', () => {
        const fixture = createRtcTopologyReplayFixture();

        expect(decideRtcTopologyReplayEntry(toDecisionInput(fixture))).toEqual({
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

        expect(decideRtcTopologyReplayEntry(toDecisionInput({ ...fixture, currentSnapshot }))).toEqual({
            status: 'deliver-current',
            currentSnapshot
        });
    });

    it('rejects a historical publication that appears to dominate current state', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry(toDecisionInput({
                ...fixture,
                currentSnapshot: { ...fixture.currentSnapshot, version: 7 }
            }))
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('rejects equal causal identity with different current content', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry(toDecisionInput({
                ...fixture,
                currentSnapshot: { ...fixture.currentSnapshot, name: 'Conflicting name' }
            }))
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('rejects a log key that differs from the immutable publication outbox', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() =>
            decideRtcTopologyReplayEntry(toDecisionInput({
                ...fixture,
                entry: {
                    ...fixture.entry,
                    outboxKey: { ...fixture.entry.outboxKey, resourceId: 'wrong-resource' }
                }
            }))
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });

    it('distinguishes missing unexpired references from a retention gap', () => {
        const fixture = createRtcTopologyReplayFixture();
        expect(() => decideRtcTopologyReplayEntry({ ...toDecisionInput(fixture), publication: { status: 'absent' } }))
            .toThrow(RtcTopologyDeliveryCorruptionError);
        expect(
            decideRtcTopologyReplayEntry({
                ...toDecisionInput(fixture),
                publication: { status: 'absent' },
                databaseNowEpochMs: fixture.entry.retainUntilEpochMs
            })
        ).toEqual({ status: 'gap' });
        expect(
            decideRtcTopologyReplayEntry({
                ...toDecisionInput(fixture),
                databaseNowEpochMs: fixture.entry.retainUntilEpochMs
            })
        ).toEqual({ status: 'gap' });
    });

    it('takes the gap path for an unexpired publication that predates envelope version 4', () => {
        const fixture = createRtcTopologyReplayFixture();
        const { traceId: _traceId, ...preV4Publication } = fixture.publication;

        expect(
            decideRtcTopologyReplayEntry({
                ...toDecisionInput(fixture),
                publication: {
                    status: 'unsupported',
                    message: 'RTC topology publication predates AL envelope version 4'
                },
                outbox: undefined
            })
        ).toEqual({ status: 'gap' });
        expect(
            decideRtcTopologyReplayEntry({
                ...toDecisionInput(fixture),
                publication: { status: 'found', publication: preV4Publication as RtcTopologyPublication }
            })
        ).toEqual({ status: 'gap' });
    });

    it('keeps a v4 publication with a malformed trace as corruption', () => {
        const fixture = createRtcTopologyReplayFixture();

        expect(() =>
            decideRtcTopologyReplayEntry({
                ...toDecisionInput(fixture),
                publication: { status: 'found', publication: { ...fixture.publication, traceId: 'not a trace' } }
            })
        ).toThrow(RtcTopologyDeliveryCorruptionError);
    });
});

function toDecisionInput(fixture: RtcTopologyReplayFixture): RtcTopologyReplayEntryDecisionInput {
    return {
        entry: fixture.entry,
        publication: { status: 'found', publication: fixture.publication },
        outbox: fixture.outbox,
        currentSnapshot: fixture.currentSnapshot,
        databaseNowEpochMs: fixture.databaseNowEpochMs
    };
}
