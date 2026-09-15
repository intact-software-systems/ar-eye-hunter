import { describe, expect, it } from 'vitest';
import type {
    ControlRunSnapshot
} from '../../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    buildDistributedRunManifest,
    defaultDistributedRecipeTargetIds,
    deriveDistributedWorldFleetTargetGate,
    distributedRecipeCommandKinds,
    distributedRecipeCrdtTransports,
    distributedRecipeStateTone,
    distributedRecipeTargetRows,
    reconcileDistributedRecipeTargetIds,
    type DistributedRecipeCatalogItem
} from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    configuredDistributedRecipeCatalogItem
} from '../../../../apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-recipe-catalog.ts';
import {
    validateDistributedRunManifest
} from '../../../shared-test/rallar-bb-test/mod.ts';
import type { RallarBlackBoxTestCrdtOpenCommand, RallarBlackBoxTestRecipe } from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { distributedRun, FULL_MESSAGING_CAPABILITY, recipe, runSnapshot } from './distributed-run-fixture.ts';

describe('distributed recipes targets', () => {
    it('derives target rows from control-agent Rallar identity', () => {
        const rows = distributedRecipeTargetRows({
            run: runSnapshot,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            nowEpochMs: 2_500
        });

        expect(rows.map((row) => [row.agentId, row.status, row.targetable])).toEqual([
            ['agent-a', 'matched', true],
            ['agent-b', 'offline', false],
            ['agent-c', 'different-group', false]
        ]);
        expect(defaultDistributedRecipeTargetIds(rows)).toEqual(['agent-a']);
    });

    it('blocks duplicate fresh normalized identities without collapsing other target evidence', () => {
        const duplicateRun: ControlRunSnapshot = {
            ...runSnapshot,
            agents: [
                {
                    ...runSnapshot.agents[0],
                    agentId: 'duplicate-a',
                    identity: {
                        ...runSnapshot.agents[0].identity,
                        principalId: ' Alice ',
                        sessionId: ' SESSION-A '
                    }
                },
                {
                    ...runSnapshot.agents[0],
                    agentId: 'duplicate-b',
                    identity: {
                        ...runSnapshot.agents[0].identity,
                        principalId: 'alice',
                        sessionId: 'session-a'
                    }
                },
                {
                    ...runSnapshot.agents[0],
                    agentId: 'stale-duplicate',
                    lastHeartbeatAtEpochMs: 1_000,
                    identity: {
                        ...runSnapshot.agents[0].identity,
                        principalId: 'alice',
                        sessionId: 'session-a'
                    }
                },
                {
                    ...runSnapshot.agents[1],
                    agentId: 'offline-agent'
                },
                {
                    ...runSnapshot.agents[2],
                    agentId: 'wrong-group-agent'
                },
                {
                    ...runSnapshot.agents[0],
                    agentId: 'missing-identity-agent',
                    identity: {
                        principalId: 'missing-scope',
                        sessionId: 'missing-scope-session'
                    }
                }
            ]
        };

        const rows = distributedRecipeTargetRows({
            run: duplicateRun,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            nowEpochMs: 2_500,
            staleAfterMs: 1_000
        });

        expect(rows.map((row) => [row.agentId, row.status, row.targetable])).toEqual([
            ['duplicate-a', 'duplicate-session', false],
            ['duplicate-b', 'duplicate-session', false],
            ['missing-identity-agent', 'missing-identity', false],
            ['offline-agent', 'offline', false],
            ['stale-duplicate', 'stale', false],
            ['wrong-group-agent', 'different-group', false]
        ]);
        expect(rows[0]?.reason).toContain('same normalized Rallar identity and session');
        expect(defaultDistributedRecipeTargetIds(rows)).toEqual([]);
    });

    it('requires only CRDT transports explicitly selected by recipe commands', () => {
        const crdtRun: ControlRunSnapshot = {
            ...runSnapshot,
            agents: [{
                ...runSnapshot.agents[0],
                identity: {
                    ...runSnapshot.agents[0].identity,
                    capabilities: {
                        crdt: {
                            supported: true,
                            transports: ['ws']
                        },
                        messaging: FULL_MESSAGING_CAPABILITY
                    }
                }
            }]
        };
        const wsCrdtOpen: RallarBlackBoxTestCrdtOpenCommand = {
            kind: 'crdt.open',
            commandId: 'open-ws-document',
            handle: 'document',
            name: 'document',
            transport: 'ws'
        };
        const wsRecipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'crdt-ws-only',
            commands: [wsCrdtOpen]
        };
        const rtcRecipe: RallarBlackBoxTestRecipe = {
            ...wsRecipe,
            recipeId: 'crdt-rtc-only',
            commands: [{
                ...wsCrdtOpen,
                transport: 'rtc'
            }]
        };

        const wsRows = distributedRecipeTargetRows({
            run: crdtRun,
            group: distributedRun.manifest.group,
            requiredCommandKinds: distributedRecipeCommandKinds(wsRecipe),
            requiredRecipes: [wsRecipe],
            nowEpochMs: 2_500
        });
        const rtcRows = distributedRecipeTargetRows({
            run: crdtRun,
            group: distributedRun.manifest.group,
            requiredCommandKinds: distributedRecipeCommandKinds(rtcRecipe),
            requiredRecipes: [rtcRecipe],
            nowEpochMs: 2_500
        });
        const kindOnlyRows = distributedRecipeTargetRows({
            run: crdtRun,
            group: distributedRun.manifest.group,
            requiredCommandKinds: ['crdt.health'],
            nowEpochMs: 2_500
        });

        expect(wsRows[0]).toMatchObject({
            status: 'matched',
            targetable: true,
            crdtTransports: ['ws']
        });
        expect(rtcRows[0]).toMatchObject({
            status: 'missing-crdt-transport',
            targetable: false,
            reason: 'Agent CRDT runtime does not report rtc transport support.'
        });
        expect(kindOnlyRows[0]).toMatchObject({
            status: 'matched',
            targetable: true
        });
    });

    it('keeps legacy selected-recipe target gating bound to the exact CRDT transport', () => {
        const group = distributedRun.manifest.group;
        const run: ControlRunSnapshot = {
            ...runSnapshot,
            agents: [{
                ...runSnapshot.agents[0],
                identity: {
                    ...runSnapshot.agents[0].identity,
                    capabilities: {
                        crdt: {
                            supported: true,
                            transports: ['ws']
                        },
                        messaging: FULL_MESSAGING_CAPABILITY
                    }
                }
            }]
        };
        const selectedItem = (transport: 'rtc' | 'ws') =>
            configuredDistributedRecipeCatalogItem({
                ...recipe,
                itemId: `legacy-crdt-${transport}`,
                recipe: {
                    schemaVersion: 1,
                    recipeId: `legacy-crdt-${transport}`,
                    commands: [{
                        kind: 'crdt.open',
                        handle: 'document',
                        name: 'document',
                        transport
                    }]
                }
            }, {
                group,
                apiBaseUrl: 'https://api.example.test',
                rtcRealtimeDurationSeconds: 5
            });
        const rowsForSelection = (selected: DistributedRecipeCatalogItem) =>
            distributedRecipeTargetRows({
                run,
                group,
                requiredCommandKinds: distributedRecipeCommandKinds(selected.recipe),
                requiredRecipes: [selected.recipe],
                nowEpochMs: 2_500
            });

        expect(rowsForSelection(selectedItem('rtc'))[0]).toMatchObject({
            status: 'missing-crdt-transport',
            targetable: false
        });
        expect(rowsForSelection(selectedItem('ws'))[0]).toMatchObject({
            status: 'matched',
            targetable: true
        });
    });

    it('synchronously excludes newly unsafe retained targets from manifests', () => {
        const group = distributedRun.manifest.group;
        const run: ControlRunSnapshot = {
            ...runSnapshot,
            agents: [{
                ...runSnapshot.agents[0],
                identity: {
                    ...runSnapshot.agents[0].identity,
                    capabilities: {
                        crdt: {
                            supported: true,
                            transports: ['ws']
                        },
                        messaging: FULL_MESSAGING_CAPABILITY
                    }
                }
            }]
        };
        const selectedRecipe = (transport: 'rtc' | 'ws'): RallarBlackBoxTestRecipe => ({
            schemaVersion: 1,
            recipeId: `safe-manifest-crdt-${transport}`,
            commands: [{
                kind: 'crdt.open',
                handle: 'document',
                name: 'document',
                transport
            }]
        });
        const manifestFor = (transport: 'rtc' | 'ws') => {
            const selected = selectedRecipe(transport);
            const rows = distributedRecipeTargetRows({
                run,
                group,
                requiredCommandKinds: distributedRecipeCommandKinds(selected),
                requiredRecipes: [selected],
                nowEpochMs: 2_500
            });
            const targetAgentIds = reconcileDistributedRecipeTargetIds(['agent-a'], rows);
            return buildDistributedRunManifest({
                distributedRunId: `safe-manifest-${transport}`,
                controlRunId: run.runId,
                group,
                recipes: [{ ...recipe, recipe: selected }],
                targetAgentIds,
                targetPolicyMode: 'selected-agents',
                rolePattern: 'all-agents',
                ackTimeoutMs: 15_000,
                startMode: 'manual',
                expectedParticipantCount: targetAgentIds.length || undefined
            });
        };

        const rtcManifest = manifestFor('rtc');
        const wsManifest = manifestFor('ws');

        expect(rtcManifest.targetPolicy.agentIds).toEqual([]);
        expect(validateDistributedRunManifest(rtcManifest)).toMatchObject({
            ok: false,
            errors: [expect.objectContaining({
                source: 'contract',
                path: '$.targetPolicy.agentIds'
            })]
        });
        expect(wsManifest.targetPolicy.agentIds).toEqual(['agent-a']);
        expect(validateDistributedRunManifest(wsManifest).ok).toBe(true);
    });

    it('derives explicit CRDT transports through every nested recipe container', () => {
        const nestedRecipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'nested-crdt-transports',
            commands: [
                {
                    kind: 'loop',
                    count: 1,
                    commands: [{
                        kind: 'crdt.sync',
                        handle: 'document',
                        transport: 'local-only'
                    }]
                },
                {
                    kind: 'parallel',
                    groups: [{
                        groupId: 'wait',
                        commands: [{
                            kind: 'crdt.wait',
                            handle: 'document',
                            sync: {
                                transport: 'rtc'
                            },
                            conditions: [{
                                source: 'health',
                                operator: 'exists'
                            }]
                        }]
                    }]
                },
                {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'nested-child',
                        commands: [{
                            kind: 'crdt.open',
                            handle: 'child-document',
                            name: 'child-document',
                            transport: 'ws-then-rtc'
                        }]
                    }
                }
            ]
        };

        expect(distributedRecipeCrdtTransports(nestedRecipe)).toEqual([
            'local-only',
            'rtc',
            'ws-then-rtc'
        ]);
    });

    it('builds role-map distributed manifests for sender receiver patterns', () => {
        const manifest = buildDistributedRunManifest({
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            recipes: [recipe, { ...recipe, itemId: 'health-2', recipe: { ...recipe.recipe, recipeId: 'health-two' } }],
            targetAgentIds: ['agent-a', 'agent-b'],
            targetPolicyMode: 'role-map',
            rolePattern: 'sender-receiver',
            ackTimeoutMs: 5_000,
            startMode: 'manual',
            expectedParticipantCount: 2
        });

        expect(manifest.targetPolicy).toMatchObject({
            mode: 'role-map',
            expectedParticipantCount: 2,
            roles: {
                sender: ['agent-a'],
                receiver: ['agent-b']
            }
        });
        expect(manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
        expect(manifest.roleAssignments?.map((assignment) => [assignment.agentId, assignment.role])).toEqual([
            ['agent-a', 'sender'],
            ['agent-b', 'receiver']
        ]);
    });

    it('builds all-online world-fleet manifests with ordered server role assignment', () => {
        const manifest = buildDistributedRunManifest({
            distributedRunId: 'dist-world-1',
            controlRunId: 'run-world-1',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group'
            },
            recipes: [recipe, { ...recipe, itemId: 'health-2', recipe: { ...recipe.recipe, recipeId: 'health-two' } }],
            targetAgentIds: [],
            targetPolicyMode: 'all-online-group-members',
            rolePattern: 'one-sender-many-receivers',
            ackTimeoutMs: 5_000,
            startMode: 'manual',
            expectedParticipantCount: 50
        });

        expect(manifest.targetPolicy).toEqual({
            mode: 'all-online-group-members',
            expectedParticipantCount: 50
        });
        expect(manifest.roleAssignments).toBeUndefined();
        expect(manifest.roleAssignmentPolicy).toEqual({
            mode: 'ordered-targets',
            pattern: 'one-sender-many-receivers',
            orderBy: 'agent-id'
        });
        expect(manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
    });

    it('maps distributed states to UI tones', () => {
        expect(distributedRecipeStateTone('ready')).toBe('good');
        expect(distributedRecipeStateTone('running')).toBe('active');
        expect(distributedRecipeStateTone('timed-out')).toBe('bad');
        expect(distributedRecipeStateTone('cancelled')).toBe('warn');
    });

    it('uses fresh world-fleet target previews before loaded run resolutions', () => {
        const loadedRunResolution = {
            group: distributedRun.manifest.group,
            resolvedAtEpochMs: 1_050,
            staleAfterMs: 30_000,
            targetPolicyMode: 'all-online-group-members' as const,
            targetAgentIds: ['agent-a', 'agent-b'],
            roleAssignments: [
                { agentId: 'agent-a', role: 'sender', required: true },
                { agentId: 'agent-b', role: 'receiver', required: true }
            ],
            blockers: [],
            summary: {
                agents: 2,
                targetable: 2,
                selected: 2,
                expectedParticipantCount: 2,
                missingExpectedParticipants: 0,
                staleAgents: 0,
                offlineAgents: 0,
                wrongGroupAgents: 0,
                agentsWithoutIdentity: 0,
                roleCounts: { receiver: 1, sender: 1 },
                regions: {},
                providers: {}
            }
        };
        const freshPreview = {
            ...loadedRunResolution,
            resolvedAtEpochMs: 2_000,
            targetAgentIds: Array.from({ length: 50 }, (_, index) => `agent-${String(index + 1).padStart(2, '0')}`),
            roleAssignments: [
                { agentId: 'agent-01', role: 'sender', required: true },
                ...Array.from({ length: 49 }, (_, index) => ({
                    agentId: `agent-${String(index + 2).padStart(2, '0')}`,
                    role: 'receiver',
                    required: true
                }))
            ],
            summary: {
                ...loadedRunResolution.summary,
                agents: 50,
                targetable: 50,
                selected: 50,
                expectedParticipantCount: 50,
                roleCounts: { receiver: 49, sender: 1 }
            }
        };

        const gate = deriveDistributedWorldFleetTargetGate({
            usesWorldFleetTargets: true,
            expectedParticipantCount: 50,
            targetResolutionPreview: freshPreview,
            selectedDistributedRun: {
                ...distributedRun,
                manifest: {
                    ...distributedRun.manifest,
                    targetPolicy: {
                        mode: 'all-online-group-members',
                        expectedParticipantCount: 2
                    }
                },
                targetResolution: loadedRunResolution
            }
        });

        expect(gate.targetResolution).toBe(freshPreview);
        expect(gate.previewSelected).toBe(50);
        expect(gate.blockReason).toBeUndefined();
    });
});
