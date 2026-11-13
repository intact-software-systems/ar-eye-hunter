import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { OverlayLayoutTransition } from '@shared/repository/overlay-layout-transition.ts';
import {
    configureOverlayRepositories,
    findAcceptedOverlayById,
    isOverlayIdentity,
    readableLayoutTransitionCache,
    reconcileAcceptedOverlayIdentity,
    removeAcceptedOverlayById,
    setAcceptedOverlayById,
    setCurrentAcceptedServerOverlayById,
    setPlannedOverlayById,
    toOverlayLayoutIdentity
} from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };
const OTHER_ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-2' };
const OVERLAY_ID = toScopedOverlayId(ROOM);

describe('overlay repository layout transition', () => {
    let nowEpochMs: number;

    beforeEach(() => {
        nowEpochMs = 1_000;
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 },
            nowEpochMs: () => nowEpochMs
        });
    });

    it('a promotion through the group snapshot keeps the layout it replaced, with the instant it was replaced', () => {
        const held = overlay({ version: 1, nextHopSessionIds: ['held-peer'] });
        const planned = overlay({ version: 2, nextHopSessionIds: ['planned-peer'] });
        setAcceptedOverlayById(OVERLAY_ID, held);
        setPlannedOverlayById(OVERLAY_ID, planned);
        nowEpochMs = 5_000;

        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: toOverlayLayoutIdentity(planned) });

        const transition = readTransition();
        expect(transition).toEqual({
            replaced: held,
            replacedBy: toOverlayLayoutIdentity(planned),
            replacedAtEpochMs: 5_000
        });
        expect(isOverlayIdentity(acceptedLayout(), transition!.replacedBy)).toBe(true);
    });

    it('a group snapshot that accepts a planned layout the held one does not precede records nothing', () => {
        const held = overlay({ groupRevision: 4, presenceRevision: 6, version: 7 });
        const incomparable = overlay({ groupRevision: 5, presenceRevision: 5, version: 8 });
        setAcceptedOverlayById(OVERLAY_ID, held);
        setPlannedOverlayById(OVERLAY_ID, incomparable);

        reconcileAcceptedOverlayIdentity({
            overlayId: OVERLAY_ID,
            acceptedIdentity: toOverlayLayoutIdentity(incomparable)
        });

        expect(acceptedLayout()).toEqual(incomparable);
        expect(readTransition()).toBeUndefined();
    });

    it('a published accepted layout that dominates the held one keeps the held one', () => {
        const held = overlay({ version: 1, nextHopSessionIds: ['held-peer'] });
        const published = overlay({ version: 2, nextHopSessionIds: ['published-peer'] });
        setAcceptedOverlayById(OVERLAY_ID, held);
        nowEpochMs = 7_000;

        expect(setAcceptedOverlayById(OVERLAY_ID, published)).toBe('adopted');

        expect(readTransition()).toEqual({
            replaced: held,
            replacedBy: toOverlayLayoutIdentity(published),
            replacedAtEpochMs: 7_000
        });
        expect(isOverlayIdentity(acceptedLayout(), readTransition()!.replacedBy)).toBe(true);
    });

    it('a bootstrap layout replaced by a server layout leaves no transition', () => {
        const bootstrap = overlay({ version: 1, provenance: 'bootstrap' });
        const published = overlay({ version: 2 });
        setAcceptedOverlayById(OVERLAY_ID, bootstrap);

        expect(setAcceptedOverlayById(OVERLAY_ID, published)).toBe('server-superseded-bootstrap');
        expect(readTransition()).toBeUndefined();

        removeAcceptedOverlayById(OVERLAY_ID);
        const planned = overlay({ version: 3 });
        setAcceptedOverlayById(OVERLAY_ID, bootstrap);
        setPlannedOverlayById(OVERLAY_ID, planned);
        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: toOverlayLayoutIdentity(planned) });

        expect(acceptedLayout()).toEqual(planned);
        expect(readTransition()).toBeUndefined();
    });

    it('a layout of another room held in the slot leaves no transition', () => {
        const otherRoom = overlay({ version: 1, groupRef: OTHER_ROOM });
        const published = overlay({ version: 2 });
        setAcceptedOverlayById(OVERLAY_ID, otherRoom);

        expect(setAcceptedOverlayById(OVERLAY_ID, published)).toBe('adopted');
        expect(readTransition()).toBeUndefined();

        const planned = overlay({ version: 3, groupRef: OTHER_ROOM });
        setPlannedOverlayById(OVERLAY_ID, planned);
        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: toOverlayLayoutIdentity(planned) });

        expect(acceptedLayout()).toEqual(planned);
        expect(readTransition()).toBeUndefined();
    });

    it('an equal, dominated or incomparable layout records nothing', () => {
        const held = overlay({ groupRevision: 4, presenceRevision: 6, version: 7 });
        setAcceptedOverlayById(OVERLAY_ID, held);

        expect(setAcceptedOverlayById(OVERLAY_ID, { ...held })).toBe('equal');
        expect(setAcceptedOverlayById(OVERLAY_ID, overlay({ groupRevision: 3, presenceRevision: 5, version: 6 })))
            .toBe('dominated-dropped');
        expect(setAcceptedOverlayById(OVERLAY_ID, overlay({ groupRevision: 5, presenceRevision: 5, version: 8 })))
            .toBe('incomparable-conflict');
        expect(readTransition()).toBeUndefined();

        const current = overlay({ groupRevision: 5, presenceRevision: 5, version: 8, nextHopSessionIds: ['peer'] });
        expect(setCurrentAcceptedServerOverlayById(OVERLAY_ID, current)).toBe('adopted');
        expect(acceptedLayout()).toEqual(current);
        expect(readTransition()).toBeUndefined();
    });

    it('a removal that no promotion follows records nothing', () => {
        setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 1 }));

        removeAcceptedOverlayById(OVERLAY_ID);
        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: undefined });

        expect(readTransition()).toBeUndefined();
    });

    it('a second promotion replaces the transition with the layout it replaced', () => {
        const first = overlay({ version: 1 });
        const second = overlay({ version: 2 });
        const third = overlay({ version: 3 });
        setAcceptedOverlayById(OVERLAY_ID, first);
        nowEpochMs = 2_000;
        setAcceptedOverlayById(OVERLAY_ID, second);
        nowEpochMs = 3_000;
        setPlannedOverlayById(OVERLAY_ID, third);

        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: toOverlayLayoutIdentity(third) });

        expect(readableLayoutTransitionCache().readAllValues()).toEqual([{
            replaced: second,
            replacedBy: toOverlayLayoutIdentity(third),
            replacedAtEpochMs: 3_000
        }]);
    });
});

function readTransition(): OverlayLayoutTransition | undefined {
    return readableLayoutTransitionCache().read(OVERLAY_ID);
}

function acceptedLayout(): OverlayInfo {
    const accepted = findAcceptedOverlayById(OVERLAY_ID);
    expect(accepted).toBeDefined();
    return accepted!;
}

interface OverlayFixtureInput {
    readonly groupRevision?: number;
    readonly presenceRevision?: number;
    readonly version: number;
    readonly nextHopSessionIds?: readonly string[];
    readonly provenance?: OverlayInfo['provenance'];
    readonly groupRef?: GroupRef;
}

function overlay(input: OverlayFixtureInput): OverlayInfo {
    const groupRef = input.groupRef ?? ROOM;
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: input.groupRevision ?? input.version,
            presenceRevision: input.presenceRevision ?? input.version
        },
        provenance: input.provenance ?? 'server',
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        topology: 'tree',
        name: 'Room',
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...(input.nextHopSessionIds ?? [])],
        nextHopsBySessionId: undefined,
        degreeLimit: 5,
        overlayVersion: input.version,
        updatedAtEpochMs: input.version
    };
}
