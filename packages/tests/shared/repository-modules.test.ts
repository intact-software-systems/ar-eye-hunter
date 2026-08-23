import type { OverlayInfo, RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientPrincipalRef, ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientVersion, readGroupVersion } from '@shared/api/group-client-views.ts';
import type { AuditStamp, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureClientStateSnapshotRepository,
    findClientStateSnapshotByPrincipalId,
    findClientStateSnapshotByRef,
    getAllClientStateSnapshots,
    onClientStateSnapshotChange,
    readableClientStateSnapshotCache,
    setClientStateSnapshotByPrincipalId,
    toClientStateSnapshotRepositoryKey,
    waitForClientStateSnapshotChangesIdle
} from '@shared/repository/client-state-snapshots-repository.ts';
import * as clientSnapshotRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
import {
    findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef,
    findGroupStateSnapshotsBySessionIds,
    getAllGroupStateSnapshots,
    onGroupStateSnapshotChange,
    removeGroupStateSnapshotByRef,
    setGroupStateSnapshot,
    setGroupStateSnapshots,
    toGroupStateSnapshotRepositoryKey,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';
import * as groupSnapshotRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { createAndSetBootstrapOverlays } from '@shared/repository/overlay-bootstrap.ts';
import {
    findOverlayById,
    getAllOverlays,
    onOverlayChange,
    OverlayRevisionConflictError,
    readOverlayAdoptionDiagnostics,
    removeOverlayById,
    resetOverlayAdoptionDiagnostics,
    setOverlayAdoptionDiagnosticsSink,
    setOverlayById,
    updateNextHopSessionIds,
    waitForOverlayChangesIdle
} from '@shared/repository/overlays-repository.ts';
import { getAllRtt, pairKey, setRtt, setRttById } from '@shared/repository/rtt-repository.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '../create-test-group.ts';

describe('repository modules', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('stores client snapshots by principal id and preserves online state', () => {
        const online = createClientSnapshot('client-1', 'session-1', 1);
        const offline = createClientSnapshot('client-2', undefined, 1);

        setClientStateSnapshotByPrincipalId(online.principal.principalId, online);
        setClientStateSnapshotByPrincipalId(offline.principal.principalId, offline);

        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(online);
        expect(getAllClientStateSnapshots().filter((snapshot) => snapshot.isOnline))
            .toEqual([
                online
            ]);
    });

    it('stores same-principal client snapshots by fully scoped ref', () => {
        const workspaceA = createClientSnapshot('client-1', 'session-a', 1);
        const workspaceB = {
            ...createClientSnapshot('client-1', 'session-b', 1),
            principal: {
                ...createClientSnapshot('client-1', 'session-b', 1).principal,
                workspaceId: 'workspace-2'
            },
            instances: createClientSnapshot('client-1', 'session-b', 1).instances
                .map((instance) => ({ ...instance, workspaceId: 'workspace-2' })),
            activeSessions: createClientSnapshot('client-1', 'session-b', 1)
                .activeSessions
                .map((session) => ({ ...session, workspaceId: 'workspace-2' }))
        } satisfies ClientSnapshot;

        expect(setClientStateSnapshotByPrincipalId('client-1', workspaceA)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', workspaceB)).toBe(true);

        expect(findClientStateSnapshotByRef(workspaceA.principal)).toEqual(workspaceA);
        expect(findClientStateSnapshotByRef(workspaceB.principal)).toEqual(workspaceB);
        expect(getAllClientStateSnapshots()).toHaveLength(2);
    });

    it('round-trips client snapshot keys with required workspace values', () => {
        type SnapshotKeyCodec = Readonly<{
            fromClientStateSnapshotRepositoryKey?: (
                key: string
            ) => Partial<ClientPrincipalRef>;
        }>;
        const codec = clientSnapshotRepositoryModule as SnapshotKeyCodec;
        const refs = [
            {
                applicationId: 'app|with:delimiters',
                workspaceId: '_',
                principalId: 'principal%2Fname'
            },
            {
                applicationId: 'app|with:delimiters',
                workspaceId: 'workspace:%25',
                principalId: 'principal%2Fname'
            }
        ] satisfies readonly ClientPrincipalRef[];

        const keys = refs.map(toClientStateSnapshotRepositoryKey);
        expect(new Set(keys).size).toBe(refs.length);
        expect(
            keys.map((key) => codec.fromClientStateSnapshotRepositoryKey?.(key) ?? null)
        ).toEqual(refs);
        expect(() =>
            toClientStateSnapshotRepositoryKey({
                applicationId: 'app',
                workspaceId: '',
                principalId: 'principal'
            })
        ).toThrow();
    });

    it('emits client snapshot changes only for accepted writes', async () => {
        const changes: string[] = [];
        const unsubscribe = onClientStateSnapshotChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = createClientSnapshot('client-1', 'session-1', 1);
            const refreshed = {
                ...first,
                principal: {
                    ...first.principal,
                    updated: {
                        ...first.principal.updated,
                        atEpochMs: first.principal.updated.atEpochMs + 1
                    }
                }
            } satisfies ClientSnapshot;
            const stale = createClientSnapshot('client-1', 'session-1', 0);
            const newer = createClientSnapshot('client-1', 'session-1', 2);

            expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(true);
            expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(false);
            expect(() => setClientStateSnapshotByPrincipalId('client-1', refreshed)).toThrow('Client snapshot revision conflict');
            expect(setClientStateSnapshotByPrincipalId('client-1', stale)).toBe(false);
            expect(setClientStateSnapshotByPrincipalId('client-1', newer)).toBe(true);
            await waitForClientStateSnapshotChangesIdle();

            expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(newer);
            expect(changes).toEqual(['created', 'updated']);
        }
        finally {
            unsubscribe();
        }
    });

    it('uses client stateRevision for cache ordering', () => {
        const first = {
            ...createClientSnapshot('client-1', 'session-1', 1),
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 1).principal,
                snapshotVersion: 10
            }
        } satisfies ClientSnapshot;
        const staleBySnapshotVersion = {
            ...createClientSnapshot('client-1', 'session-1', 99),
            stateRevision: 0,
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 99).principal,
                snapshotVersion: 9
            }
        } satisfies ClientSnapshot;
        const newer = {
            ...createClientSnapshot('client-1', 'session-1', 2),
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 2).principal,
                snapshotVersion: 11
            }
        } satisfies ClientSnapshot;

        expect(readClientVersion(first)).toBe(10);
        expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', staleBySnapshotVersion)).toBe(false);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(first);
        expect(setClientStateSnapshotByPrincipalId('client-1', newer)).toBe(true);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(newer);
    });

    it('rejects stale and conflicting client state revisions', () => {
        const accepted = {
            ...createClientSnapshot('client-1', 'session-new', 1),
            stateRevision: 2
        } satisfies ClientSnapshot;
        const stale = {
            ...createClientSnapshot('client-1', 'session-stale', 99),
            stateRevision: 1
        } satisfies ClientSnapshot;
        const conflict = {
            ...accepted,
            activeSessionCount: 0
        } satisfies ClientSnapshot;

        expect(setClientStateSnapshotByPrincipalId('client-1', accepted)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', stale)).toBe(false);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(accepted);
        expect(() => setClientStateSnapshotByPrincipalId('client-1', conflict))
            .toThrow('Client snapshot revision conflict');
    });

    it('conditionally removes only the unchanged client snapshot identity', () => {
        type ConditionalClientRemoval = Readonly<{
            removeClientStateSnapshotIfUnchanged?: (
                ref: ClientPrincipalRef,
                expected: ClientSnapshot
            ) => boolean;
        }>;
        const conditionalRemoval = clientSnapshotRepositoryModule as ConditionalClientRemoval;
        const first = createClientSnapshot('client-1', 'session-old', 1);
        const newer = createClientSnapshot('client-1', 'session-new', 2);

        expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', newer)).toBe(true);

        expect(
            conditionalRemoval.removeClientStateSnapshotIfUnchanged?.(
                first.principal,
                first
            ) ?? false
        ).toBe(false);
        expect(findClientStateSnapshotByRef(first.principal)).toBe(newer);

        expect(
            conditionalRemoval.removeClientStateSnapshotIfUnchanged?.(
                newer.principal,
                newer
            ) ?? false
        ).toBe(true);
        expect(findClientStateSnapshotByRef(newer.principal)).toBeUndefined();
    });

    it('stores group snapshots by scoped ref, keeps newer versions, and finds memberships', () => {
        const first = createGroupSnapshot('group-1', 'Alpha', 1, [
            'self',
            'peer-a'
        ]);
        const stale = createGroupSnapshot('group-1', 'Alpha', 0, ['self']);
        const second = createGroupSnapshot('group-2', 'Beta', 1, [
            'self',
            'peer-b'
        ]);

        expect(setGroupStateSnapshots([first, second])).toBe(true);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
        expect(findGroupStateSnapshotByRef(second.group)).toEqual(second);
        expect(findFirstGroupStateSnapshotRefSessionIdIsIn('peer-a')).toEqual(
            first.group
        );
        expect(getAllGroupStateSnapshots()).toEqual([first, second]);

        expect(setGroupStateSnapshot(stale)).toBe(false);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
    });

    it('finds group snapshots by all active session ids using current memberships', () => {
        const first = createGroupSnapshot('group-1', 'Alpha', 1, [
            'self',
            'peer-a'
        ]);
        const second = createGroupSnapshot('group-2', 'Beta', 1, [
            'self',
            'peer-b'
        ]);
        const updatedFirst = createGroupSnapshot('group-1', 'Alpha', 2, [
            'self',
            'peer-c'
        ]);

        expect(setGroupStateSnapshots([first, second])).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-a']))
            .toEqual([first]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-b']))
            .toEqual([second]);

        expect(setGroupStateSnapshot(updatedFirst)).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-a']))
            .toEqual([]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-c']))
            .toEqual([updatedFirst]);

        expect(removeGroupStateSnapshotByRef(updatedFirst.group)).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-c']))
            .toEqual([]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-b']))
            .toEqual([second]);
    });

    it('keeps same group id snapshots isolated across workspaces', () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'Workspace A',
            1,
            ['session-a'],
            {
                workspaceId: 'workspace-a'
            }
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'Workspace B',
            1,
            ['session-b'],
            {
                workspaceId: 'workspace-b'
            }
        );

        expect(setGroupStateSnapshots([workspaceA, workspaceB])).toBe(true);

        expect(
            getAllGroupStateSnapshots()
                .map((snapshot) => ({
                    workspaceId: snapshot.group.workspaceId,
                    displayName: snapshot.group.displayName
                }))
                .sort((left, right) => (left.workspaceId ?? '').localeCompare(right.workspaceId ?? ''))
        ).toEqual([
            {
                workspaceId: 'workspace-a',
                displayName: 'Workspace A'
            },
            {
                workspaceId: 'workspace-b',
                displayName: 'Workspace B'
            }
        ]);
        expect(findGroupStateSnapshotByRef(workspaceA.group)).toEqual(workspaceA);
        expect(findGroupStateSnapshotByRef(workspaceB.group)).toEqual(workspaceB);
        expect(findFirstGroupStateSnapshotRefSessionIdIsIn('session-b')).toEqual(
            workspaceB.group
        );
    });

    it('round-trips group snapshot keys with required workspace values', () => {
        type SnapshotKeyCodec = Readonly<{
            fromGroupStateSnapshotRepositoryKey?: (
                key: string
            ) => Partial<GroupSnapshot['group']>;
        }>;
        const codec = groupSnapshotRepositoryModule as SnapshotKeyCodec;
        const refs = [
            {
                applicationId: 'app|with:delimiters',
                workspaceId: '_',
                groupId: 'group%2Fname'
            } as GroupSnapshot['group'],
            {
                applicationId: 'app|with:delimiters',
                workspaceId: 'workspace:%25',
                groupId: 'group%2Fname'
            } as GroupSnapshot['group']
        ] satisfies readonly GroupSnapshot['group'][];

        const keys = refs.map(toGroupStateSnapshotRepositoryKey);
        expect(new Set(keys).size).toBe(refs.length);
        expect(
            keys.map((key) => codec.fromGroupStateSnapshotRepositoryKey?.(key) ?? null)
        ).toEqual(refs);
        expect(() =>
            toGroupStateSnapshotRepositoryKey({
                applicationId: 'app',
                workspaceId: '',
                groupId: 'group'
            })
        ).toThrow();
    });

    it('uses the full group causal tuple for cache ordering', () => {
        const first = {
            ...createGroupSnapshot('group-1', 'Alpha', 1, ['self']),
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 1, ['self']).group,
                snapshotVersion: 10
            }
        } satisfies GroupSnapshot;
        const staleBySnapshotVersion = {
            ...createGroupSnapshot('group-1', 'Alpha', 99, ['self', 'peer-stale']),
            causalRevision: { groupRevision: 0, presenceRevision: 0 },
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 99, ['self', 'peer-stale']).group,
                snapshotVersion: 9
            }
        } satisfies GroupSnapshot;
        const newer = {
            ...createGroupSnapshot('group-1', 'Alpha', 2, ['self', 'peer-a']),
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 2, ['self', 'peer-a']).group,
                snapshotVersion: 11
            }
        } satisfies GroupSnapshot;

        expect(readGroupVersion(first)).toBe(10);
        expect(setGroupStateSnapshot(first)).toBe(true);
        expect(setGroupStateSnapshot(staleBySnapshotVersion)).toBe(false);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
        expect(setGroupStateSnapshot(newer)).toBe(true);
        expect(findGroupStateSnapshotByRef(newer.group)).toEqual(newer);
    });

    it('rejects stale and conflicting group causal revisions', () => {
        const accepted = {
            ...createGroupSnapshot('group-1', 'Alpha', 1, ['session-new']),
        } satisfies GroupSnapshot;
        const stale = {
            ...createGroupSnapshot('group-1', 'Stale', 99, ['session-stale']),
            causalRevision: { groupRevision: 0, presenceRevision: 0 }
        } satisfies GroupSnapshot;
        const conflict = {
            ...accepted,
            onlineMemberCount: 0
        } satisfies GroupSnapshot;

        expect(setGroupStateSnapshot(accepted)).toBe(true);
        expect(setGroupStateSnapshot(stale)).toBe(false);
        expect(findGroupStateSnapshotByRef(accepted.group)).toEqual(accepted);
        expect(() => setGroupStateSnapshot(conflict))
            .toThrow('Group snapshot revision conflict');
    });

    it('conditionally removes only the unchanged group and session-index identity', () => {
        type ConditionalGroupRemoval = Readonly<{
            removeGroupStateSnapshotIfUnchanged?: (
                ref: GroupSnapshot['group'],
                expected: GroupSnapshot
            ) => boolean;
        }>;
        const conditionalRemoval = groupSnapshotRepositoryModule as ConditionalGroupRemoval;
        const first = createGroupSnapshot('group-1', 'Alpha', 1, [
            'self',
            'session-old'
        ]);
        const newer = createGroupSnapshot('group-1', 'Alpha', 2, [
            'self',
            'session-new'
        ]);

        expect(setGroupStateSnapshot(first)).toBe(true);
        expect(setGroupStateSnapshot(newer)).toBe(true);

        expect(
            conditionalRemoval.removeGroupStateSnapshotIfUnchanged?.(
                first.group,
                first
            ) ?? false
        ).toBe(false);
        expect(findGroupStateSnapshotByRef(first.group)).toBe(newer);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'session-new']))
            .toEqual([newer]);

        expect(
            conditionalRemoval.removeGroupStateSnapshotIfUnchanged?.(
                newer.group,
                newer
            ) ?? false
        ).toBe(true);
        expect(findGroupStateSnapshotByRef(newer.group)).toBeUndefined();
        expect(findGroupStateSnapshotsBySessionIds(['self', 'session-new']))
            .toEqual([]);
    });

    it('emits group snapshot changes only for accepted writes', async () => {
        const changes: string[] = [];
        const unsubscribe = onGroupStateSnapshotChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = createGroupSnapshot('group-1', 'Alpha', 1, ['self']);
            const refreshed = {
                ...first,
                group: {
                    ...first.group,
                    updated: {
                        ...first.group.updated,
                        atEpochMs: first.group.updated.atEpochMs + 1
                    }
                }
            } satisfies GroupSnapshot;
            const stale = createGroupSnapshot('group-1', 'Alpha', 0, ['self']);
            const newer = createGroupSnapshot('group-1', 'Alpha', 2, [
                'self',
                'peer-a'
            ]);

            expect(setGroupStateSnapshot(first)).toBe(true);
            expect(setGroupStateSnapshot(first)).toBe(false);
            expect(() => setGroupStateSnapshot(refreshed))
                .toThrow('Group snapshot revision conflict');
            expect(setGroupStateSnapshot(stale)).toBe(false);
            expect(setGroupStateSnapshot(newer)).toBe(true);
            await waitForGroupStateSnapshotChangesIdle();

            expect(findGroupStateSnapshotByRef(newer.group)).toEqual(newer);
            expect(changes).toEqual(['created', 'updated']);
        }
        finally {
            unsubscribe();
        }
    });

    it('stores overlays by overlay id and preserves newer versions', () => {
        const group = createGroupSnapshot('group-1', 'Alpha', 2, [
            'self',
            'peer-a',
            'peer-b'
        ]);
        const overlayId = toScopedOverlayId(group.group);

        createAndSetBootstrapOverlays([group], {
            localSessionId: 'self',
            bootstrapDegree: 2
        });

        expect(findOverlayById(overlayId)).toEqual({
            sourceGroupStateCausalRevision: group.causalRevision,
            provenance: 'bootstrap',
            state: 'active',
            overlayId,
            groupRef: group.group,
            topology: 'star',
            name: 'Alpha',
            createdByClientId: 'self',
            createdAtEpochMs: 1,
            nextHopSessionIds: expect.arrayContaining(['peer-a', 'peer-b']),
            degreeLimit: 2,
            overlayVersion: 2,
            updatedAtEpochMs: 2
        });

        const currentOverlay = findOverlayById(overlayId);
        if (currentOverlay === undefined) {
            throw new Error('Expected seeded overlay');
        }
        const staleOverlay = {
            ...currentOverlay,
            nextHopSessionIds: ['peer-z'],
            overlayVersion: 1
        };

        setOverlayById(overlayId, staleOverlay);
        expect(findOverlayById(overlayId)?.nextHopSessionIds).toEqual(
            currentOverlay.nextHopSessionIds
        );

        expect(updateNextHopSessionIds(overlayId, ['peer-c'])).toMatchObject({
            overlayId,
            nextHopSessionIds: currentOverlay.nextHopSessionIds
        });
        expect(findOverlayById(overlayId)?.nextHopSessionIds).toEqual(['peer-c']);
        expect(getAllOverlays()).toHaveLength(1);
    });

    it('emits overlay changes only for accepted writes and deletes', async () => {
        const changes: string[] = [];
        const unsubscribe = onOverlayChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = {
                sourceGroupStateCausalRevision: {
                    groupRevision: 1,
                    presenceRevision: 1
                },
                provenance: 'server',
                state: 'active',
                overlayId: 'group-1',
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'group-1'
                },
                topology: 'star',
                name: 'Alpha',
                createdByClientId: 'owner',
                createdAtEpochMs: 1,
                nextHopSessionIds: ['self'],
                degreeLimit: 1,
                overlayVersion: 1,
                updatedAtEpochMs: 1
            } satisfies OverlayInfo;
            const stale = {
                ...first,
                nextHopSessionIds: ['peer-stale'],
                overlayVersion: 0
            } satisfies OverlayInfo;
            const newer = {
                ...first,
                nextHopSessionIds: ['self', 'peer-a'],
                overlayVersion: 2,
                updatedAtEpochMs: 2
            } satisfies OverlayInfo;

            setOverlayById('group-1', first);
            setOverlayById('group-1', first);
            setOverlayById('group-1', stale);
            setOverlayById('group-1', newer);
            expect(removeOverlayById('group-1')).toBe(true);
            await waitForOverlayChangesIdle();

            expect(changes).toEqual(['created', 'updated', 'deleted']);
            expect(findOverlayById('group-1')).toBeUndefined();
        }
        finally {
            unsubscribe();
        }
    });

    it('reports every overlay adoption outcome through the diagnostics sink', () => {
        const outcomes: string[] = [];
        resetOverlayAdoptionDiagnostics();
        setOverlayAdoptionDiagnosticsSink((event) => {
            outcomes.push(event.outcome);
        });

        try {
            const overlayId = 'group-adoption';
            const first = {
                sourceGroupStateCausalRevision: {
                    groupRevision: 1,
                    presenceRevision: 1
                },
                provenance: 'server',
                state: 'active',
                overlayId,
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: overlayId
                },
                topology: 'star',
                name: 'Alpha',
                createdByClientId: 'owner',
                createdAtEpochMs: 1,
                nextHopSessionIds: ['self'],
                degreeLimit: 1,
                overlayVersion: 1,
                updatedAtEpochMs: 1
            } satisfies OverlayInfo;
            const stale = { ...first, overlayVersion: 0 } satisfies OverlayInfo;
            const newer = { ...first, overlayVersion: 2 } satisfies OverlayInfo;
            const conflicting = {
                ...newer,
                nextHopSessionIds: ['peer-x']
            } satisfies OverlayInfo;
            const incomparable = {
                ...first,
                sourceGroupStateCausalRevision: {
                    groupRevision: 2,
                    presenceRevision: 0
                }
            } satisfies OverlayInfo;

            setOverlayById(overlayId, first);
            setOverlayById(overlayId, first);
            setOverlayById(overlayId, stale);
            setOverlayById(overlayId, newer);
            expect(() => setOverlayById(overlayId, conflicting)).toThrow(
                OverlayRevisionConflictError
            );
            expect(() => setOverlayById(overlayId, incomparable)).toThrow(
                OverlayRevisionConflictError
            );

            expect(outcomes).toEqual([
                'initial-set',
                'equal',
                'dominated-dropped',
                'adopted',
                'incomparable-conflict',
                'incomparable-conflict'
            ]);

            expect(readOverlayAdoptionDiagnostics()).toEqual({
                initialSetCount: 1,
                adoptedCount: 1,
                equalCount: 1,
                dominatedDroppedCount: 1,
                incomparableConflictCount: 2,
                serverSupersededBootstrapCount: 0,
                bootstrapDroppedOverServerCount: 0
            });

            setOverlayAdoptionDiagnosticsSink(() => {
                throw new Error('diagnostics sink failure');
            });
            const adoptedDespiteSinkFailure = {
                ...newer,
                overlayVersion: 3
            } satisfies OverlayInfo;
            setOverlayById(overlayId, adoptedDespiteSinkFailure);
            expect(findOverlayById(overlayId)?.overlayVersion).toBe(3);
            expect(readOverlayAdoptionDiagnostics().adoptedCount).toBe(2);

            resetOverlayAdoptionDiagnostics();
            expect(readOverlayAdoptionDiagnostics().adoptedCount).toBe(0);
        }
        finally {
            setOverlayAdoptionDiagnosticsSink(undefined);
        }
    });

    it('admits server overlays over bootstrap overlays regardless of the causal tuple', () => {
        const outcomes: string[] = [];
        resetOverlayAdoptionDiagnostics();
        setOverlayAdoptionDiagnosticsSink((event) => {
            outcomes.push(event.outcome);
        });

        try {
            const overlayId = 'group-provenance';
            const bootstrap = {
                sourceGroupStateCausalRevision: {
                    groupRevision: 5,
                    presenceRevision: 5
                },
                provenance: 'bootstrap',
                state: 'active',
                overlayId,
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: overlayId
                },
                topology: 'star',
                name: 'Alpha',
                createdByClientId: 'owner',
                createdAtEpochMs: 1,
                nextHopSessionIds: ['peer-bootstrap'],
                degreeLimit: 1,
                overlayVersion: 5,
                updatedAtEpochMs: 5
            } satisfies OverlayInfo;
            const dominatedServer = {
                ...bootstrap,
                provenance: 'server',
                sourceGroupStateCausalRevision: {
                    groupRevision: 1,
                    presenceRevision: 1
                },
                nextHopSessionIds: ['peer-server'],
                overlayVersion: 1
            } satisfies OverlayInfo;
            const dominatingBootstrap = {
                ...bootstrap,
                sourceGroupStateCausalRevision: {
                    groupRevision: 9,
                    presenceRevision: 9
                },
                overlayVersion: 9
            } satisfies OverlayInfo;
            const newerServer = {
                ...dominatedServer,
                sourceGroupStateCausalRevision: {
                    groupRevision: 2,
                    presenceRevision: 2
                },
                nextHopSessionIds: ['peer-server-2'],
                overlayVersion: 2
            } satisfies OverlayInfo;

            setOverlayById(overlayId, bootstrap);
            setOverlayById(overlayId, dominatedServer);
            expect(findOverlayById(overlayId)?.nextHopSessionIds)
                .toEqual(['peer-server']);

            setOverlayById(overlayId, dominatingBootstrap);
            expect(findOverlayById(overlayId)?.provenance).toBe('server');
            expect(findOverlayById(overlayId)?.nextHopSessionIds)
                .toEqual(['peer-server']);

            setOverlayById(overlayId, newerServer);
            setOverlayById(overlayId, {
                ...dominatedServer,
                nextHopSessionIds: ['peer-server-stale']
            });
            expect(findOverlayById(overlayId)?.nextHopSessionIds)
                .toEqual(['peer-server-2']);

            expect(outcomes).toEqual([
                'initial-set',
                'server-superseded-bootstrap',
                'bootstrap-dropped-over-server',
                'adopted',
                'dominated-dropped'
            ]);
            expect(readOverlayAdoptionDiagnostics()).toMatchObject({
                serverSupersededBootstrapCount: 1,
                bootstrapDroppedOverServerCount: 1,
                incomparableConflictCount: 0
            });
        }
        finally {
            setOverlayAdoptionDiagnosticsSink(undefined);
            resetOverlayAdoptionDiagnostics();
        }
    });

    it('orders revisioned overlays by source group revision and retains removal tombstones', () => {
        const first = {
            overlayId: 'overlay-1',
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 2
            },
            provenance: 'server',
            state: 'active',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'group-1'
            },
            topology: 'star',
            name: 'Room',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['peer-a'],
            degreeLimit: 1,
            overlayVersion: 1,
            updatedAtEpochMs: 2
        } satisfies OverlayInfo;
        setOverlayById(first.overlayId, first);
        setOverlayById(first.overlayId, {
            ...first,
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1
            },
            overlayVersion: 99,
            nextHopSessionIds: ['stale-peer']
        });
        expect(findOverlayById(first.overlayId)).toEqual(first);

        const removed = {
            ...first,
            sourceGroupStateCausalRevision: {
                groupRevision: 3,
                presenceRevision: 3
            },
            state: 'removed',
            nextHopSessionIds: []
        } satisfies OverlayInfo;
        setOverlayById(first.overlayId, removed);
        expect(findOverlayById(first.overlayId)).toBeUndefined();
        expect(getAllOverlays()).toEqual([]);

        setOverlayById(first.overlayId, first);
        expect(findOverlayById(first.overlayId)).toBeUndefined();
    });

    it('normalizes RTT pair keys and keeps only newer measurements', () => {
        const older = createRttMeasurement('peer-b', 'peer-a', 1, 10);
        const newer = createRttMeasurement('peer-a', 'peer-b', 2, 20);

        expect(pairKey('peer-a', 'peer-b')).toBe(pairKey('peer-b', 'peer-a'));
        expect(setRtt(older)).toBe(true);
        expect(setRttById(pairKey('peer-a', 'peer-b'), older)).toBe(false);
        expect(setRtt(newer)).toBe(true);
        expect(getAllRtt()).toEqual([newer]);
    });

    it('requires explicit configuration and isolates custom managers', () => {
        const isolatedManager = new RepositoryManager();

        expect(() => readableClientStateSnapshotCache(isolatedManager)).toThrow(
            'Repository not found: shared.repository.client-state-snapshots'
        );

        configureClientStateSnapshotRepository({ ttlMs: 5_000 }, isolatedManager);
        setClientStateSnapshotByPrincipalId(
            'client-iso',
            createClientSnapshot('client-iso', 'session-iso', 1),
            isolatedManager
        );

        expect(
            findClientStateSnapshotByPrincipalId('client-iso', isolatedManager)
                ?.activeSessions[0]
                ?.sessionId
        ).toBe('session-iso');
        expect(findClientStateSnapshotByPrincipalId('client-iso')).toBeUndefined();
    });
});

function createClientSnapshot(
    principalId: string,
    sessionId: string | undefined,
    version: number
): ClientSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const activeSessions: readonly ClientSession[] = sessionId
        ? [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            generationId: `${sessionId}:generation-1`,
            generationVersion: version,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            connectionId: null,
            authenticatedAtEpochMs: version,
            connectedAtEpochMs: version,
            lastHeartbeatAtEpochMs: version,
            expiresAtEpochMs: version + 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }]
        : [];

    return {
        stateRevision: version,
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion: version,
            profileVersion: 0,
            presenceVersion: version,
            created: createPrincipalAuditStamp(1, principalId),
            updated: createPrincipalAuditStamp(version, principalId),
            lastSeenAtEpochMs: sessionId ? version : null
        },
        instances: sessionId
            ? [{
                applicationId,
                workspaceId,
                principalId,
                clientInstanceId: `${principalId}-instance`,
                status: 'active',
                revoked: null,
                platform: 'web',
                deviceLabel: null,
                appVersion: null,
                userAgent: null,
                capabilities: [],
                registered: createPrincipalAuditStamp(1, principalId),
                updated: createPrincipalAuditStamp(version, principalId)
            }]
            : [],
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs: sessionId ? version : null
    };
}

function createGroupSnapshot(
    groupId: string,
    displayName: string,
    membershipVersion: number,
    memberSessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {}
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    const ownerPrincipalId = memberSessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }

    return {
        causalRevision: {
            groupRevision: membershipVersion,
            presenceRevision: membershipVersion
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            slug: groupId,
            displayName,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: createPrincipalAuditStamp(1, ownerPrincipalId),
            updated: createPrincipalAuditStamp(
                membershipVersion,
                ownerPrincipalId
            )
        }),
        members: memberSessionIds.map((sessionId): GroupMember => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: createPrincipalAuditStamp(1, ownerPrincipalId),
            updated: createPrincipalAuditStamp(
                membershipVersion,
                ownerPrincipalId
            ),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: memberSessionIds.map((sessionId): GroupPresenceSession => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: membershipVersion,
            expiresAtEpochMs: membershipVersion + 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function createPrincipalAuditStamp(
    atEpochMs: number,
    principalId: string
): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function createRttMeasurement(
    sessionIdFrom: string,
    sessionIdTo: string,
    version: number,
    rttMs: number
): RttMeasurementInfo {
    return {
        sessionIdFrom,
        sessionIdTo,
        version,
        rttMs,
        createdAtEpochMs: version
    };
}
