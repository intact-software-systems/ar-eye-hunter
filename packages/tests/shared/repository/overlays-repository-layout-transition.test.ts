import { MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS, type OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { MAX_RECORDED_LAYOUT_TRANSITIONS } from '@shared/repository/compute-recorded-layout-transitions.ts';
import type { OverlayLayoutTransition } from '@shared/repository/overlay-layout-transition.ts';
import {
    configureOverlayRepositories,
    findAcceptedOverlayById,
    readableLayoutTransitionCache,
    reconcileAcceptedOverlayIdentity,
    removeAcceptedOverlayByGroupRef,
    removeAcceptedOverlayById,
    removeAcceptedOverlayByIdIfUnchanged,
    setAcceptedOverlayById,
    setCurrentAcceptedServerOverlayById,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';
import { isOverlayIdentity, toOverlayLayoutIdentity } from '@shared/repository/to-overlay-layout-identity.ts';
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

let nowEpochMs: number;

describe('overlay repository layout transition', () => {
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

    it('keeps the transitions of two promotions a second apart, newest first', () => {
        const first = overlay({ version: 1 });
        const second = overlay({ version: 2 });
        const third = overlay({ version: 3 });
        setAcceptedOverlayById(OVERLAY_ID, first);
        nowEpochMs = 2_000;
        setAcceptedOverlayById(OVERLAY_ID, second);
        nowEpochMs = 3_000;
        setPlannedOverlayById(OVERLAY_ID, third);

        reconcileAcceptedOverlayIdentity({ overlayId: OVERLAY_ID, acceptedIdentity: toOverlayLayoutIdentity(third) });

        expect(readableLayoutTransitionCache().readAllValues()).toEqual([[
            { replaced: second, replacedBy: toOverlayLayoutIdentity(third), replacedAtEpochMs: 3_000 },
            { replaced: first, replacedBy: toOverlayLayoutIdentity(second), replacedAtEpochMs: 2_000 }
        ]]);
    });

    it('drops a transition once its own largest window has passed', () => {
        promoteAt([1, 2], 2_000);
        nowEpochMs = 2_000 + MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS - 1;
        setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 3 }));
        expect(readTransitions()?.map((transition) => transition.replaced.overlayVersion)).toEqual([2, 1]);

        nowEpochMs = 2_000 + MAX_RTC_REPLACED_LAYOUT_OVERLAP_MS;
        setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 4 }));
        expect(readTransitions()?.map((transition) => transition.replaced.overlayVersion)).toEqual([3, 2]);
    });

    it('drops a transition stamped after now', () => {
        promoteAt([1, 2], 20_000);
        nowEpochMs = 10_000;
        setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 3 }));

        expect(readTransitions()).toEqual([
            { replaced: overlay({ version: 2 }), replacedBy: toOverlayLayoutIdentity(overlay({ version: 3 })), replacedAtEpochMs: 10_000 }
        ]);
    });

    it('keeps the 16 most recent transitions and drops the oldest', () => {
        setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 1 }));
        for (let version = 2; version <= 18; version += 1) {
            nowEpochMs += 100;
            setAcceptedOverlayById(OVERLAY_ID, overlay({ version }));
        }

        const replacedVersions = readTransitions()?.map((transition) => transition.replaced.overlayVersion);
        expect(replacedVersions).toHaveLength(MAX_RECORDED_LAYOUT_TRANSITIONS);
        expect(replacedVersions).toEqual(Array.from({ length: 16 }, (_, index) => 17 - index));
    });

    it('clearing the layout clears its history', () => {
        promoteAt([1, 2, 3], 2_000);
        expect(readTransitions()).toHaveLength(2);

        removeAcceptedOverlayById(OVERLAY_ID);

        expect(readTransitions()).toBeUndefined();
    });

    it('a transition does not survive two repairs that return the accepted slot to the layout that made it', () => {
        const replaced = overlay({ groupRevision: 3, presenceRevision: 5, version: 6 });
        const promoted = overlay({ groupRevision: 4, presenceRevision: 6, version: 7 });
        const repair = overlay({ groupRevision: 5, presenceRevision: 5, version: 8 });
        promote(replaced, promoted);

        expect(setCurrentAcceptedServerOverlayById(OVERLAY_ID, repair)).toBe('adopted');
        expect(readTransition()).toBeUndefined();

        expect(setCurrentAcceptedServerOverlayById(OVERLAY_ID, promoted)).toBe('adopted');
        expect(acceptedLayout()).toEqual(promoted);
        expect(readTransition()).toBeUndefined();
    });

    it('a transition does not survive the removal and re-adoption of the layout that made it', () => {
        const replaced = overlay({ version: 1 });
        const promoted = overlay({ version: 2 });
        promote(replaced, promoted);

        removeAcceptedOverlayById(OVERLAY_ID);
        expect(setAcceptedOverlayById(OVERLAY_ID, promoted)).toBe('initial-set');

        expect(acceptedLayout()).toEqual(promoted);
        expect(readTransition()).toBeUndefined();
    });

    it.each([
        { removal: 'by id', remove: (held: OverlayInfo) => removeAcceptedOverlayById(held.overlayId) },
        { removal: 'by group ref', remove: (held: OverlayInfo) => removeAcceptedOverlayByGroupRef(held.groupRef) },
        {
            removal: 'by id while unchanged',
            remove: (held: OverlayInfo) => removeAcceptedOverlayByIdIfUnchanged(held.overlayId, findAcceptedOverlayById(held.overlayId))
        },
        {
            removal: 'through a group snapshot that names no accepted layout',
            remove: (held: OverlayInfo) => reconcileAcceptedOverlayIdentity({ overlayId: held.overlayId, acceptedIdentity: undefined })
        }
    ])('a removal of the accepted layout clears the transition ($removal)', ({ remove }) => {
        const promoted = overlay({ version: 2 });
        promote(overlay({ version: 1 }), promoted);

        expect(remove(promoted)).toBe(true);

        expect(findAcceptedOverlayById(OVERLAY_ID)).toBeUndefined();
        expect(readTransition()).toBeUndefined();
    });

    it('an accepted write that changes nothing keeps the transition', () => {
        const replaced = overlay({ groupRevision: 3, presenceRevision: 5, version: 6 });
        const promoted = overlay({ groupRevision: 4, presenceRevision: 6, version: 7 });
        promote(replaced, promoted);
        const recorded = readTransition();

        expect(setAcceptedOverlayById(OVERLAY_ID, { ...promoted })).toBe('equal');
        expect(setAcceptedOverlayById(OVERLAY_ID, replaced)).toBe('dominated-dropped');
        expect(setAcceptedOverlayById(OVERLAY_ID, overlay({ groupRevision: 5, presenceRevision: 5, version: 8 })))
            .toBe('incomparable-conflict');

        expect(acceptedLayout()).toEqual(promoted);
        expect(readTransition()).toEqual(recorded);
        expect(recorded?.replaced).toEqual(replaced);
    });

    it('a removed layout that takes the accepted slot records nothing and clears the transition', () => {
        const promoted = overlay({ version: 2 });
        promote(overlay({ version: 1 }), promoted);
        const retired: OverlayInfo = { ...promoted, state: 'removed', nextHopSessionIds: [] };

        expect(setAcceptedOverlayById(OVERLAY_ID, retired)).toBe('adopted');

        expect(readTransition()).toBeUndefined();
    });

    it('a replaced layout that is not active is never recorded', () => {
        const active = overlay({ version: 1 });
        const retired: OverlayInfo = { ...active, state: 'removed', nextHopSessionIds: [] };
        setAcceptedOverlayById(OVERLAY_ID, active);
        expect(setAcceptedOverlayById(OVERLAY_ID, retired)).toBe('adopted');

        expect(setAcceptedOverlayById(OVERLAY_ID, overlay({ version: 2 }))).toBe('adopted');

        expect(readTransition()).toBeUndefined();
    });

    it('a planned layout that dominates the planned layout it replaces leaves no transition', () => {
        setPlannedOverlayById(OVERLAY_ID, overlay({ version: 1 }));

        expect(setPlannedOverlayById(OVERLAY_ID, overlay({ version: 2 }))).toBe('adopted');

        expect(readTransition()).toBeUndefined();
    });
});

function promote(replaced: OverlayInfo, promoted: OverlayInfo): void {
    setAcceptedOverlayById(OVERLAY_ID, replaced);
    expect(setAcceptedOverlayById(OVERLAY_ID, promoted)).toBe('adopted');
    expect(readTransition()?.replaced).toEqual(replaced);
}

/** The most recent transition. */
function readTransition(): OverlayLayoutTransition | undefined {
    return readTransitions()?.[0];
}

function readTransitions(): readonly OverlayLayoutTransition[] | undefined {
    return readableLayoutTransitionCache().read(OVERLAY_ID);
}

/** Accepts each version in turn, the second at `firstPromotionAtEpochMs` and each next one a second later. */
function promoteAt(versions: readonly number[], firstPromotionAtEpochMs: number): void {
    setAcceptedOverlayById(OVERLAY_ID, overlay({ version: versions[0]! }));
    versions.slice(1).forEach((version, index) => {
        nowEpochMs = firstPromotionAtEpochMs + index * 1_000;
        expect(setAcceptedOverlayById(OVERLAY_ID, overlay({ version }))).toBe('adopted');
    });
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
