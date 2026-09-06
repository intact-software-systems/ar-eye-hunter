import { describe, expect, it } from 'vitest';

import { toRallarRoomFormationStatus } from '@shared-web/browser/rooms/formation/room-formation-observation.ts';

import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

describe('room formation status projection', () => {
    it('projects a formation status from the snapshot and the two layout slots', () => {
        const snapshot = createFormationSnapshot({
            stage: 'reconnecting',
            formationEpoch: 4,
            causalRevision: { groupRevision: 6, presenceRevision: 2 }
        });
        const accepted = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 3, presenceRevision: 2 },
            version: 2
        });
        const planned = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 6, presenceRevision: 2 },
            version: 5
        });
        const withAcceptedIdentity = {
            ...snapshot,
            group: {
                ...snapshot.group,
                acceptedLayoutIdentity: { groupRevision: 3, presenceRevision: 2, version: 2, state: 'active' as const }
            }
        };

        const status = toRallarRoomFormationStatus({ snapshot: withAcceptedIdentity, planned, accepted });

        expect(status.stage).toBe('reconnecting');
        expect(status.dialing).toBe('accepted-and-planned');
        expect(status.accepted?.identity).toEqual({ groupRevision: 3, presenceRevision: 2, version: 2, state: 'active' });
        expect(status.planned?.identity).toEqual({ groupRevision: 6, presenceRevision: 2, version: 5, state: 'active' });
        expect(status.condition).toBeUndefined();
    });

    it('reports the activation condition only while the stored status describes the current series', () => {
        const snapshot = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 2 }
        });
        const identity = { groupRevision: 5, presenceRevision: 2, version: 4, state: 'active' as const };
        const accepted = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 5, presenceRevision: 2 },
            version: 4
        });
        const withStatus = (formationEpoch: number) => ({
            ...snapshot,
            group: {
                ...snapshot.group,
                acceptedLayoutIdentity: identity,
                activationStatus: {
                    condition: 'degraded' as const,
                    coverageRate: 0.6,
                    coverageBasisLayoutIdentity: identity,
                    formationEpoch,
                    evidenceWatermark: null,
                    publishedAtEpochMs: 5
                }
            }
        });

        const current = toRallarRoomFormationStatus({ snapshot: withStatus(3), planned: undefined, accepted });
        const spent = toRallarRoomFormationStatus({ snapshot: withStatus(2), planned: undefined, accepted });

        expect([current.condition, current.coverageRate]).toEqual(['degraded', 0.6]);
        expect([spent.condition, spent.coverageRate]).toEqual([undefined, undefined]);
    });

    it('reports no accepted layout when the slot does not match the snapshot identity, and no planned layout for a tombstone', () => {
        const snapshot = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        const stale = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            version: 1
        });
        const tombstone = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 3, presenceRevision: 1 },
            version: 4,
            state: 'removed'
        });

        const status = toRallarRoomFormationStatus({ snapshot, planned: tombstone, accepted: stale });

        expect(status.accepted).toBeUndefined();
        expect(status.planned).toBeUndefined();
    });
});
