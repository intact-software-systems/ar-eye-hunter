import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../shared-test/rallar-bb-test/control-snapshots.ts';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
} from '../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { distributedRunMonitorDerivationWorkForTest } from
    '../../shared-test/rallar-bb-test/distributed-run-monitor-index.ts';

const SCALE = 5_000;
// Captured from the pre-index implementation before Task 6A production edits.
const PRE_INDEX_MONITOR_SHA256 =
    'fa00d7b1056a20a68e99c154285eeb444dd517e08c25986eb499dbbe2624162f';
const PRE_INDEX_REPORT_SHA256 =
    '863b2130b109c34ef474a3f306623bfe4c0cd3e9209fe350e25639cccf41d415';
const PRE_INDEX_VERDICT_SHA256 =
    'd52788b32fb4dfbada1c092580c8546de9faab055eb728c7f4a3f0fc32ed35b5';
const PRE_MEMBERSHIP_INDEX_MONITOR_SHA256 =
    '3d35dc6ea97ca5f97f53b9a1d4cca53be3be4486cfe77c4937f50ad6758cb14d';

describe('distributed run monitor indexed derivation', () => {
    it('preserves the complete pre-index monitor, report, and verdict observables at 5,000 scale',
        () => {
            const input = adversarialScaleInput();
            const monitor = deriveDistributedRunMonitor(input);
            const report = deriveDistributedRunAnalysisReport({
                ...input,
                monitor,
                snapshotBounds: {
                    commands: SCALE,
                    results: SCALE,
                    events: SCALE,
                },
            });
            const verdict = deriveRunVerdictView({
                distributedRun: input.distributedRun,
                monitor,
                report,
                refreshedAtEpochMs: 90_000,
            });

            expect(sha256(monitor)).toBe(PRE_INDEX_MONITOR_SHA256);
            expect(sha256(report)).toBe(PRE_INDEX_REPORT_SHA256);
            expect(sha256(verdict)).toBe(PRE_INDEX_VERDICT_SHA256);
            expect(distributedRunMonitorDerivationWorkForTest(report)).toEqual({
                monitorDerivationCount: 1,
                reportDerivationCount: 1,
                commandLinkIndexPassCount: 1,
                commandLinkVisitCount: SCALE,
                controlCommandIndexPassCount: 1,
                controlCommandVisitCount: SCALE,
                controlResultIndexPassCount: 1,
                controlResultVisitCount: SCALE,
                controlEventIndexPassCount: 1,
                controlEventVisitCount: SCALE,
                linkedEventAgentIndexVisitCount: monitor.events.length,
                failureIndexVisitCount: monitor.failures.length,
                targetAgentIndexPassCount: 1,
                targetAgentVisitCount: SCALE,
                recipeSelectionIndexPassCount: 1,
                recipeSelectionVisitCount: 3,
                roleAssignmentIndexPassCount: 1,
                roleAssignmentVisitCount: 0,
                targetPolicyRoleMembershipVisitCount: 0,
                membershipDescriptorBuildCount: SCALE,
                membershipInvertedIndexWriteCount: 0,
                membershipIntersectionCandidateVisitCount: 0,
                recipeTargetCountProjectionVisitCount: 3,
                retainedMembershipDescriptorCount: SCALE,
                retainedRecipeTargetCountCount: 3,
                commandLinkCompletionProbeCount: SCALE,
                agentLinkBucketLookupCount: SCALE,
                agentEventBucketLookupCount: SCALE,
                agentRoleLookupCount: SCALE * 2,
                agentLinkProjectionVisitCount: SCALE,
                agentEventProjectionVisitCount: monitor.events.length,
                recipeLinkBucketLookupCount: 3,
                recipeLinkProjectionVisitCount: 1_176,
                recipeTargetCountLookupCount: 3,
                linkedAgentExpectedMembershipProbeCount: 1_176,
                readinessLinkBucketLookupCount: SCALE,
                readinessStageLinkProjectionVisitCount: 1_250,
                timelineCommandLinkProjectionVisitCount: SCALE,
                diagnosticFailureCandidateVisitCount: 2,
                reportCommandLinkLookupCount: 4,
                reportFallbackCommandLinkIndexPassCount: 0,
                reportFallbackCommandLinkVisitCount: 0,
                reportFallbackCommandPhaseLookupCount: 0,
            });
        }, 30_000);

    it('indexes 5,000 role assignments and expected recipe memberships once', () => {
        const input = adversarialScaleInput();
        const recipeIds = input.distributedRun.manifest.recipes.map(
            selection => selection.recipeId!,
        );
        const roleAssignments = input.distributedRun.targetAgentIds.map(
            (agentId, index) => ({
                agentId,
                role: index % 3 === 2 ? 'role:other|界' : 'role:receiver\u202E|界',
                recipeIds: index % 3 === 0
                    ? [recipeIds[0]!]
                    : index % 3 === 1
                    ? []
                    : ['unknown:recipe|界'],
                required: true,
            }),
        );
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    ...input.distributedRun.manifest.recipes[0]!,
                    role: undefined,
                }, {
                    ...input.distributedRun.manifest.recipes[1]!,
                    role: 'role:receiver\u202E|界',
                }, {
                    ...input.distributedRun.manifest.recipes[2]!,
                    role: undefined,
                }],
                roleAssignments,
            },
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        });
        const work = distributedRunMonitorDerivationWorkForTest(monitor);

        expect(sha256(monitor)).toBe(PRE_MEMBERSHIP_INDEX_MONITOR_SHA256);
        expect(work).toEqual({
            monitorDerivationCount: 1,
            reportDerivationCount: 0,
            commandLinkIndexPassCount: 1,
            commandLinkVisitCount: SCALE,
            controlCommandIndexPassCount: 1,
            controlCommandVisitCount: SCALE,
            controlResultIndexPassCount: 1,
            controlResultVisitCount: SCALE,
            controlEventIndexPassCount: 1,
            controlEventVisitCount: SCALE,
            linkedEventAgentIndexVisitCount: monitor.events.length,
            failureIndexVisitCount: monitor.failures.length,
            targetAgentIndexPassCount: 1,
            targetAgentVisitCount: SCALE,
            recipeSelectionIndexPassCount: 1,
            recipeSelectionVisitCount: recipeIds.length,
            roleAssignmentIndexPassCount: 1,
            roleAssignmentVisitCount: SCALE,
            targetPolicyRoleMembershipVisitCount: 0,
            membershipDescriptorBuildCount: SCALE,
            membershipInvertedIndexWriteCount: 5_001,
            membershipIntersectionCandidateVisitCount: 0,
            recipeTargetCountProjectionVisitCount: recipeIds.length,
            retainedMembershipDescriptorCount: SCALE,
            retainedRecipeTargetCountCount: recipeIds.length,
            commandLinkCompletionProbeCount: SCALE,
            agentLinkBucketLookupCount: SCALE,
            agentEventBucketLookupCount: SCALE,
            agentRoleLookupCount: SCALE * 2,
            agentLinkProjectionVisitCount: SCALE,
            agentEventProjectionVisitCount: monitor.events.length,
            recipeLinkBucketLookupCount: recipeIds.length,
            recipeLinkProjectionVisitCount: 1_176,
            recipeTargetCountLookupCount: recipeIds.length,
            linkedAgentExpectedMembershipProbeCount: 1_176,
            readinessLinkBucketLookupCount: SCALE,
            readinessStageLinkProjectionVisitCount: 1_250,
            timelineCommandLinkProjectionVisitCount: SCALE,
            diagnosticFailureCandidateVisitCount: 2,
            reportCommandLinkLookupCount: 0,
            reportFallbackCommandLinkIndexPassCount: 0,
            reportFallbackCommandLinkVisitCount: 0,
            reportFallbackCommandPhaseLookupCount: 0,
        });
        expect(monitor.agentProgress[0]?.role).toBe('role:receiver\u202E|界');
        expect(monitor.readiness[0]?.role).toBe('role:receiver\u202E|界');
        expect(monitor.recipeProgress.map(row => row.targetCount)).toEqual([
            5_000,
            3_334,
            3_333,
        ]);
    }, 30_000);

    it('compresses a 2,000 by 2,000 all-unroled membership matrix', () => {
        const dimension = 2_000;
        const input = focusedInput({
            agentIds: Array.from(
                { length: dimension },
                (_, index) => `matrix-agent-${index}`,
            ),
            recipeIds: Array.from(
                { length: dimension },
                (_, index) => `matrix-recipe-${index}`,
            ),
            links: [],
        });

        const monitor = deriveDistributedRunMonitor(input);
        const work = distributedRunMonitorDerivationWorkForTest(monitor);

        expect(monitor.recipeProgress).toHaveLength(dimension);
        expect(monitor.recipeProgress[0]).toMatchObject({
            targetCount: dimension,
            missingCount: dimension,
        });
        expect(monitor.recipeProgress.at(-1)).toMatchObject({
            targetCount: dimension,
            missingCount: dimension,
        });
        expect(work).toEqual(twoDimensionalMonitorWork(dimension));
        expect(work).not.toHaveProperty('expectedRecipeMembershipWriteCount');
        expect(work).not.toHaveProperty('expectedRecipeMembershipProjectionVisitCount');
        expect(work).not.toHaveProperty('expectedRecipeAgentBucketLookupCount');
    }, 30_000);

    it('aggregates a 2,000 by 2,000 same-role membership matrix', () => {
        const dimension = 2_000;
        const role = 'matrix-role|\u202E界';
        const agentIds = Array.from(
            { length: dimension },
            (_, index) => `role-matrix-agent-${index}`,
        );
        const input = focusedInput({
            agentIds,
            recipeIds: Array.from(
                { length: dimension },
                (_, index) => `role-matrix-recipe-${index}`,
            ),
            links: [],
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: input.distributedRun.manifest.recipes.map(selection => ({
                    ...selection,
                    role,
                })),
                roleAssignments: agentIds.map(agentId => ({
                    agentId,
                    role,
                    recipeIds: [],
                })),
            },
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        });
        const work = distributedRunMonitorDerivationWorkForTest(monitor);

        expect(monitor.recipeProgress).toHaveLength(dimension);
        expect(monitor.recipeProgress[0]).toMatchObject({
            targetCount: dimension,
            missingCount: dimension,
        });
        expect(monitor.recipeProgress.at(-1)).toMatchObject({
            targetCount: dimension,
            missingCount: dimension,
        });
        expect(work).toEqual({
            ...twoDimensionalMonitorWork(dimension),
            roleAssignmentVisitCount: dimension,
            membershipInvertedIndexWriteCount: dimension,
        });
        expect(work).not.toHaveProperty('explicitRecipeMembershipVisitCount');
    }, 30_000);

    it('preserves resolved-empty precedence and duplicate target order', () => {
        const input = focusedInput({
            agentIds: ['agent:duplicate|\u202E界', 'agent:duplicate|\u202E界'],
            recipeIds: ['manifest-role', 'unroled'],
            links: [],
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    recipeId: 'manifest-role',
                    role: 'role:manifest|界',
                    required: true,
                }, {
                    recipeId: 'resolved-role',
                    role: 'role:resolved|界',
                    required: true,
                }, {
                    recipeId: 'unroled',
                    required: true,
                }],
                roleAssignments: [{
                    agentId: 'agent:duplicate|\u202E界',
                    role: 'role:manifest|界',
                    recipeIds: ['manifest-role'],
                    required: true,
                }],
            },
            targetResolution: focusedTargetResolution({
                targetAgentIds: input.distributedRun.targetAgentIds,
                roleAssignments: [],
            }),
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        });

        expect(monitor.agentProgress).toHaveLength(1);
        expect(monitor.agentProgress[0]?.role).toBeUndefined();
        expect(monitor.readiness.map(row => [row.agentId, row.role])).toEqual([
            ['agent:duplicate|\u202E界', undefined],
            ['agent:duplicate|\u202E界', undefined],
        ]);
        expect(monitor.recipeProgress.map(row => [row.recipeId, row.targetCount]))
            .toEqual([
                ['manifest-role', 0],
                ['resolved-role', 0],
                ['unroled', 2],
            ]);

        const resolvedMonitor = deriveDistributedRunMonitor({
            distributedRun: {
                ...distributedRun,
                targetResolution: focusedTargetResolution({
                    targetAgentIds: distributedRun.targetAgentIds,
                    roleAssignments: [{
                        agentId: 'agent:duplicate|\u202E界',
                        role: 'role:resolved|界',
                        recipeIds: [],
                    }],
                }),
            },
            controlRun: input.controlRun,
        });
        expect(resolvedMonitor.agentProgress[0]?.role).toBe('role:resolved|界');
        expect(resolvedMonitor.recipeProgress.map(row => [row.recipeId, row.targetCount]))
            .toEqual([
                ['manifest-role', 0],
                ['resolved-role', 2],
                ['unroled', 2],
            ]);
    });

    it('preserves assignment order, role and id selection, duplicate selections, and unroled fallback', () => {
        const emptyAgentId = '';
        const assignedAgentId = 'agent:id|role:\u202E界';
        const policyAgentId = 'agent:policy|界';
        const fallbackAgentId = 'agent:fallback|界';
        const matchingRole = 'role:duplicate|\u202E界';
        const input = focusedInput({
            agentIds: [
                emptyAgentId,
                assignedAgentId,
                policyAgentId,
                fallbackAgentId,
                fallbackAgentId,
            ],
            recipeIds: [],
            links: [],
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    recipeId: 'recipe:id-only|\u202E界',
                    role: 'role:not-assigned',
                    required: true,
                }, {
                    recipeId: 'recipe:duplicate|界',
                    role: matchingRole,
                    required: true,
                }, {
                    recipeId: 'recipe:duplicate|界',
                    role: matchingRole,
                    required: true,
                }, {
                    recipeId: '',
                    required: true,
                }, {
                    recipeId: 'recipe:fallback|界',
                    required: true,
                }],
                targetPolicy: {
                    ...input.distributedRun.manifest.targetPolicy,
                    roles: { [matchingRole]: [policyAgentId] },
                },
                roleAssignments: [{
                    agentId: assignedAgentId,
                    role: matchingRole,
                    recipeIds: ['recipe:id-only|\u202E界'],
                }, {
                    agentId: assignedAgentId,
                    role: matchingRole,
                    recipeIds: [],
                }, {
                    agentId: assignedAgentId,
                    role: 'role:third|界',
                }, {
                    agentId: emptyAgentId,
                    role: '',
                    recipeIds: ['recipe:unknown|界'],
                }, {
                    agentId: fallbackAgentId,
                    role: 'role:no-match|界',
                    recipeIds: ['recipe:unknown|界'],
                }],
            },
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        });

        expect(monitor.agentProgress.find(row => row.agentId === assignedAgentId)?.role)
            .toBe(`${matchingRole}, ${matchingRole}, role:third|界`);
        expect(monitor.agentProgress.find(row => row.agentId === emptyAgentId)?.role)
            .toBe('');
        expect(monitor.agentProgress.find(row => row.agentId === policyAgentId)?.role)
            .toBeUndefined();
        expect(monitor.readiness.map(row => row.agentId)).toEqual(
            distributedRun.targetAgentIds,
        );
        expect(monitor.recipeProgress.map(row => [
            row.recipeId,
            row.role,
            row.targetCount,
        ])).toEqual([
            ['recipe:id-only|\u202E界', 'role:not-assigned', 1],
            ['recipe:duplicate|界', matchingRole, 2],
            ['recipe:duplicate|界', matchingRole, 2],
            ['recipe-4', undefined, 4],
            ['recipe:fallback|界', undefined, 4],
        ]);
    });

    it('counts direct-id and role overlap once and caches duplicate selection intersections', () => {
        const role = 'role:overlap|界';
        const input = focusedInput({
            agentIds: ['overlap-agent', 'overlap-agent', 'role-agent', 'direct-agent'],
            recipeIds: [],
            links: [],
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{ recipeId: 'shared-recipe', role }, {
                    recipeId: 'shared-recipe', role,
                }],
                roleAssignments: [{
                    agentId: 'overlap-agent', role, recipeIds: ['shared-recipe'],
                }, {
                    agentId: 'role-agent', role, recipeIds: [],
                }, {
                    agentId: 'direct-agent', role: 'role:other',
                    recipeIds: ['shared-recipe'],
                }],
            },
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        });

        expect(monitor.recipeProgress.map(row => [
            row.targetCount,
            row.missingCount,
        ])).toEqual([[4, 4], [4, 4]]);
        expect(distributedRunMonitorDerivationWorkForTest(monitor)).toMatchObject({
            membershipIntersectionCandidateVisitCount: 2,
            recipeTargetCountProjectionVisitCount: 2,
        });
    });

    it('reads each raw target, recipe selection, role assignment, and command link at most once', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a', 'recipe-b'],
            links: [{
                phase: 'stage', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'command-a', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'agent-b', recipeId: 'recipe-b',
                commandId: 'command-b', queuedAtEpochMs: 2,
            }],
            results: [focusedResult('command-b', 'agent-b', false, 10)],
        });
        const roleAssignments = [{
            agentId: 'agent-a', role: 'role-a', recipeIds: ['recipe-a'],
        }, {
            agentId: 'agent-b', role: 'role-b', recipeIds: ['recipe-b'],
        }];
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            targetAgentIds: singleReadArray(input.distributedRun.targetAgentIds, 'targets'),
            commandLinks: singleReadArray(input.distributedRun.commandLinks, 'links'),
            manifest: {
                ...input.distributedRun.manifest,
                recipes: singleReadArray(input.distributedRun.manifest.recipes, 'recipes'),
                roleAssignments: singleReadArray(roleAssignments, 'assignments'),
            },
        };

        let report: ReturnType<typeof deriveDistributedRunAnalysisReport> | undefined;
        expect(() => {
            const monitor = deriveDistributedRunMonitor({
                distributedRun,
                controlRun: input.controlRun,
            });
            report = deriveDistributedRunAnalysisReport({
                distributedRun,
                controlRun: input.controlRun,
                monitor,
            });
        }).not.toThrow();
        expect(distributedRunMonitorDerivationWorkForTest(report!)).toMatchObject({
            monitorDerivationCount: 1,
            reportDerivationCount: 1,
            commandLinkVisitCount: 2,
            reportCommandLinkLookupCount: 1,
        });
    });

    it('keeps delimiter-colliding agent and recipe identities isolated', () => {
        const links: ControlDistributedRunSnapshot['commandLinks'] = [{
            phase: 'start', agentId: 'agent:a', recipeId: 'b',
            commandId: 'command-a', queuedAtEpochMs: 1,
        }, {
            phase: 'start', agentId: 'agent', recipeId: 'a:b',
            commandId: 'command-b', queuedAtEpochMs: 2,
        }, {
            phase: 'start', agentId: 'agent|a', recipeId: 'b',
            commandId: 'command-c', queuedAtEpochMs: 3,
        }, {
            phase: 'start', agentId: 'agent', recipeId: 'a|b',
            commandId: 'command-d', queuedAtEpochMs: 4,
        }];
        const input = focusedInput({
            agentIds: ['agent:a', 'agent', 'agent|a'],
            recipeIds: ['b', 'a:b', 'a|b'],
            links,
            results: [
                focusedResult('command-a', 'agent:a', false, 10),
                focusedResult('command-b', 'agent', true, 11),
                focusedResult('command-c', 'agent|a', true, 12),
                focusedResult('command-d', 'agent', false, 13),
            ],
            events: [{
                kind: 'event', protocolVersion: 1, runId: 'focused-control',
                agentId: 'agent:a', commandId: 'command-a', atEpochMs: 20,
                eventId: 'event-agent-colon', payload: { message: 'colon' },
            }, {
                kind: 'event', protocolVersion: 1, runId: 'focused-control',
                agentId: 'agent', commandId: 'command-b', atEpochMs: 21,
                eventId: 'event-recipe-colon', payload: { message: 'recipe colon' },
            }, {
                kind: 'event', protocolVersion: 1, runId: 'focused-control',
                agentId: 'agent|a', commandId: 'command-c', atEpochMs: 22,
                eventId: 'event-agent-pipe', payload: { message: 'pipe' },
            }],
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.agentProgress.find(row => row.agentId === 'agent:a')).toMatchObject({
            failedCommandCount: 1,
            eventCount: 1,
        });
        expect(monitor.agentProgress.find(row => row.agentId === 'agent')).toMatchObject({
            failedCommandCount: 1,
            resultCount: 2,
            eventCount: 1,
        });
        expect(monitor.agentProgress.find(row => row.agentId === 'agent|a')).toMatchObject({
            failedCommandCount: 0,
            eventCount: 1,
        });
        expect(monitor.recipeProgress.map(row => [
            row.recipeId,
            row.passedCount,
            row.failedCount,
        ])).toEqual([
            ['b', 1, 1],
            ['a:b', 1, 0],
            ['a|b', 0, 1],
        ]);
    });

    it('preserves undefined versus empty recipe links and absent versus empty control truth', () => {
        const links: ControlDistributedRunSnapshot['commandLinks'] = [{
            phase: 'start', agentId: 'agent-a', recipeId: undefined,
            commandId: 'undefined-recipe', queuedAtEpochMs: 1,
        }, {
            phase: 'start', agentId: 'agent-b', recipeId: '',
            commandId: 'empty-recipe', queuedAtEpochMs: 2,
        }];
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['only-recipe'],
            links,
            results: [
                focusedResult('undefined-recipe', 'agent-a', true, 10),
                focusedResult('empty-recipe', 'agent-b', true, 11),
            ],
        });
        const monitor = deriveDistributedRunMonitor(input);
        expect(monitor.recipeProgress[0]).toMatchObject({
            recipeId: 'only-recipe',
            targetCount: 2,
            passedCount: 1,
            missingCount: 1,
        });

        const withoutControl = deriveDistributedRunMonitor({
            distributedRun: input.distributedRun,
        });
        const withEmptyControl = deriveDistributedRunMonitor({
            distributedRun: input.distributedRun,
            controlRun: {
                ...input.controlRun,
                commands: [], results: [], events: [],
            },
        });
        expect(withoutControl).toEqual(withEmptyControl);
    });

    it('preserves last-result lookup while counting every linked result envelope', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b', 'agent-c'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'command-a', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'agent-b', recipeId: 'recipe-a',
                commandId: 'command-b', queuedAtEpochMs: 2,
            }, {
                phase: 'start', agentId: 'agent-c', recipeId: 'recipe-a',
                commandId: 'command-c', queuedAtEpochMs: 3,
            }],
            results: [
                focusedResult('command-a', 'agent-a', true, 10),
                focusedResult('command-b', 'agent-b', false, 11),
                focusedResult('command-b', 'agent-b', true, 12),
            ],
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.resultCounts).toEqual({ total: 3, ok: 2, failed: 1 });
        expect(monitor.agentProgress.reduce((sum, row) => sum + row.resultCount, 0)).toBe(2);
        expect(monitor.agentProgress.find(row => row.agentId === 'agent-b')).toMatchObject({
            failedCommandCount: 0,
            execution: 'passed',
        });
    });

    it('keeps first-link failure-action semantics when command IDs are duplicated', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'duplicate-command', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'agent-b', recipeId: 'recipe-a',
                commandId: 'duplicate-command', queuedAtEpochMs: 2,
            }],
            results: [focusedResult('duplicate-command', 'agent-a', false, 10)],
        });
        const monitor = deriveDistributedRunMonitor(input);
        const report = deriveDistributedRunAnalysisReport({ ...input, monitor });

        expect(report.nextActions.find(action => action.category === 'command')?.nextAction)
            .toContain('recipe-load output');
        expect(distributedRunMonitorDerivationWorkForTest(report))
            .toMatchObject({ reportCommandLinkLookupCount: 1 });
    });

    it('keeps tracked command-link lookups local to each report', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'local-report-lookup', queuedAtEpochMs: 1,
            }],
            results: [focusedResult('local-report-lookup', 'agent-a', false, 10)],
        });
        const monitor = deriveDistributedRunMonitor(input);

        const firstReport = deriveDistributedRunAnalysisReport({ ...input, monitor });
        const secondReport = deriveDistributedRunAnalysisReport({ ...input, monitor });

        expect([
            distributedRunMonitorDerivationWorkForTest(firstReport)
                .reportCommandLinkLookupCount,
            distributedRunMonitorDerivationWorkForTest(secondReport)
                .reportCommandLinkLookupCount,
            distributedRunMonitorDerivationWorkForTest(monitor)
                .reportCommandLinkLookupCount,
        ]).toEqual([1, 1, 0]);
        expect([
            distributedRunMonitorDerivationWorkForTest(firstReport)
                .reportDerivationCount,
            distributedRunMonitorDerivationWorkForTest(secondReport)
                .reportDerivationCount,
            distributedRunMonitorDerivationWorkForTest(monitor)
                .reportDerivationCount,
        ]).toEqual([1, 1, 0]);
    });

    it('falls back to report command links when a monitor came from another run object', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'cross-snapshot-command', queuedAtEpochMs: 1,
            }],
            results: [focusedResult('cross-snapshot-command', 'agent-a', false, 10)],
        });
        const monitor = deriveDistributedRunMonitor(input);
        const reportRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            commandLinks: [{
                ...input.distributedRun.commandLinks[0]!,
                phase: 'start',
            }],
        };
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor: { ...monitor },
        });

        expect(deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor,
        })).toEqual(headReport);
        expect(headReport.nextActions.find(action => action.category === 'command')?.nextAction)
            .toContain('composite drilldown');
    });

    it('falls back when the same run object receives a different command-links array', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'replaced-links-command', queuedAtEpochMs: 1,
            }],
            results: [focusedResult('replaced-links-command', 'agent-a', false, 10)],
        });
        const mutableRun = { ...input.distributedRun };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: mutableRun,
            controlRun: input.controlRun,
        });
        Object.assign(mutableRun, {
            commandLinks: [{
                ...input.distributedRun.commandLinks[0]!,
                phase: 'start',
            }],
        });
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: mutableRun,
            monitor: { ...monitor },
        });

        expect(deriveDistributedRunAnalysisReport({
            distributedRun: mutableRun,
            monitor,
        })).toEqual(headReport);
        expect(headReport.nextActions.find(action => action.category === 'command')?.nextAction)
            .toContain('composite drilldown');
    });

    it('does not index 5,000 fallback links when a cross-run monitor has no failures', () => {
        const scaleInput = adversarialScaleInput();
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: [],
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const reportRun: ControlDistributedRunSnapshot = {
            ...scaleInput.distributedRun,
            commandLinks: noReadArray(
                scaleInput.distributedRun.commandLinks,
                'no-failure fallback links',
            ),
        };
        let report: ReturnType<typeof deriveDistributedRunAnalysisReport> | undefined;

        expect(() => {
            report = deriveDistributedRunAnalysisReport({
                distributedRun: reportRun,
                monitor: suppliedMonitor,
            });
        }).not.toThrow();
        expect(distributedRunMonitorDerivationWorkForTest(report!)).toMatchObject({
            reportFallbackCommandLinkIndexPassCount: 0,
            reportFallbackCommandLinkVisitCount: 0,
            reportFallbackCommandPhaseLookupCount: 0,
        });
    });

    it('lazily indexes 5,000 fallback links once for one cross-run command failure', () => {
        const scaleInput = adversarialScaleInput();
        const failedCommandId = scaleInput.distributedRun.commandLinks.at(-1)!.commandId;
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: [{
                phase: 'stage', agentId: 'supplied-agent',
                recipeId: 'supplied-recipe', commandId: failedCommandId,
                queuedAtEpochMs: 1,
            }],
            results: [focusedResult(failedCommandId, 'supplied-agent', false, 10)],
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: scaleInput.distributedRun,
            monitor: { ...suppliedMonitor },
        });
        const reportRun: ControlDistributedRunSnapshot = {
            ...scaleInput.distributedRun,
            commandLinks: singleReadArray(
                scaleInput.distributedRun.commandLinks,
                'one-failure fallback links',
            ),
        };

        const report = deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor: suppliedMonitor,
        });

        expect(report).toEqual(headReport);
        expect(distributedRunMonitorDerivationWorkForTest(headReport)).toMatchObject({
            monitorDerivationCount: 0,
            reportDerivationCount: 1,
            reportFallbackCommandLinkIndexPassCount: 1,
            reportFallbackCommandLinkVisitCount: SCALE,
            reportFallbackCommandPhaseLookupCount: 1,
        });
        expect(distributedRunMonitorDerivationWorkForTest(report)).toMatchObject({
            reportCommandLinkLookupCount: 0,
            reportFallbackCommandLinkIndexPassCount: 1,
            reportFallbackCommandLinkVisitCount: SCALE,
            reportFallbackCommandPhaseLookupCount: 1,
        });
    }, 30_000);

    it('preserves verdict output when a caller supplies a monitor but omits the report', () => {
        const verdictInput = focusedInput({
            agentIds: ['verdict-agent'],
            recipeIds: ['verdict-recipe'],
            links: [],
        });
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: [{
                phase: 'start', agentId: 'supplied-agent',
                recipeId: 'supplied-recipe', commandId: 'supplied-failure',
                queuedAtEpochMs: 1,
            }],
            results: [focusedResult('supplied-failure', 'supplied-agent', false, 10)],
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: verdictInput.distributedRun,
        });

        expect(deriveRunVerdictView({
            distributedRun: verdictInput.distributedRun,
            monitor: suppliedMonitor,
            refreshedAtEpochMs: 123,
        })).toEqual(deriveRunVerdictView({
            distributedRun: verdictInput.distributedRun,
            monitor: suppliedMonitor,
            report: headReport,
            refreshedAtEpochMs: 123,
        }));
    });

    it('preserves diagnostic correlation order, duplicate keys, and inclusive time bounds', () => {
        const distributedRunId = 'focused-distributed';
        const input = focusedInput({
            agentIds: ['failure-agent', 'other-agent', 'boundary-agent', 'duplicate-key'],
            recipeIds: ['recipe-a'],
            updatedAtEpochMs: 30_000,
            links: [{
                phase: 'start', agentId: 'failure-agent', recipeId: 'recipe-a',
                commandId: 'exact-command', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'boundary-agent', recipeId: 'recipe-a',
                commandId: 'near-15000', queuedAtEpochMs: 2,
            }, {
                phase: 'start', agentId: 'boundary-agent', recipeId: 'recipe-a',
                commandId: 'far-15001', queuedAtEpochMs: 3,
            }, {
                phase: 'start', agentId: 'duplicate-key', recipeId: 'recipe-a',
                commandId: 'duplicate-key', queuedAtEpochMs: 4,
            }],
            results: [
                focusedResult('exact-command', 'failure-agent', false, 12_000),
                focusedResult('near-15000', 'boundary-agent', false, 10_000),
                focusedResult('far-15001', 'boundary-agent', false, 9_999),
            ],
            failures: [{
                kind: 'participant', key: 'duplicate-key', state: 'failed', required: true,
            }, {
                kind: 'recipe', key: 'duplicate-key', state: 'failed', required: true,
            }],
            events: [
                focusedDiagnostic('diagnostic-exact', 'other-agent', 40_000, {
                    commandId: 'exact-command', distributedRunId,
                }),
                focusedDiagnostic('diagnostic-duplicates', 'other-agent', 40_001, {
                    commandId: 'duplicate-key', distributedRunId,
                }),
                focusedDiagnostic('diagnostic-boundary', 'boundary-agent', 25_000, {
                    distributedRunId,
                }),
            ],
        });

        const diagnostics = new Map(deriveDistributedRunMonitor(input)
            .runtimeDiagnostics.map(row => [row.eventId, row.correlatedFailureKeys]));

        expect(diagnostics.get('diagnostic-exact')).toContain('exact-command');
        expect(diagnostics.get('diagnostic-duplicates')).toEqual([
            'duplicate-key',
            'duplicate-key',
        ]);
        expect(diagnostics.get('diagnostic-boundary')).toContain('near-15000');
        expect(diagnostics.get('diagnostic-boundary')).not.toContain('far-15001');
    });

    it('does not time-correlate a diagnostic with an empty agent identity', () => {
        const input = focusedInput({
            agentIds: [''],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start', agentId: '', recipeId: 'recipe-a',
                commandId: 'empty-agent-failure', queuedAtEpochMs: 1,
            }],
            results: [focusedResult('empty-agent-failure', '', false, 10_000)],
            events: [focusedDiagnostic('empty-agent-diagnostic', '', 10_001, {
                distributedRunId: 'focused-distributed',
            })],
        });

        expect(deriveDistributedRunMonitor(input).runtimeDiagnostics[0]
            ?.correlatedFailureKeys).toEqual([]);
    });

    it('does not time-correlate non-finite diagnostic or failure timestamps', () => {
        const input = focusedInput({
            agentIds: ['nan-failure-agent', 'nan-diagnostic-agent'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start', agentId: 'nan-failure-agent', recipeId: 'recipe-a',
                commandId: 'nan-failure', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'nan-diagnostic-agent', recipeId: 'recipe-a',
                commandId: 'finite-failure', queuedAtEpochMs: 2,
            }],
            results: [
                focusedResult('nan-failure', 'nan-failure-agent', false, Number.NaN),
                focusedResult('finite-failure', 'nan-diagnostic-agent', false, 10_000),
            ],
            events: [
                focusedDiagnostic('finite-diagnostic', 'nan-failure-agent', 10_000, {
                    distributedRunId: 'focused-distributed',
                }),
                focusedDiagnostic('nan-diagnostic', 'nan-diagnostic-agent', Number.NaN, {
                    distributedRunId: 'focused-distributed',
                }),
            ],
        });

        expect(deriveDistributedRunMonitor(input).runtimeDiagnostics.map(row =>
            [row.eventId, row.correlatedFailureKeys]
        )).toEqual([
            ['finite-diagnostic', []],
            ['nan-diagnostic', []],
        ]);
    });

    it('keeps event fallback indexes post-sort and diagnostic indexes pre-sort', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start', agentId: 'agent-a', recipeId: 'recipe-a',
                commandId: 'command-a', queuedAtEpochMs: 1,
            }, {
                phase: 'start', agentId: 'agent-b', recipeId: 'recipe-a',
                commandId: 'command-b', queuedAtEpochMs: 2,
            }],
            events: [
                focusedDiagnostic(undefined, 'agent-a', 200, { commandId: 'command-a' }),
                focusedDiagnostic(undefined, 'agent-b', 100, { commandId: 'command-b' }),
            ],
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.events.map(row => row.eventId)).toEqual([
            'agent-b-command-b-0',
            'agent-a-command-a-1',
        ]);
        expect(monitor.runtimeDiagnostics.map(row => row.eventId)).toEqual([
            'agent-b-command-b-1',
            'agent-a-command-a-0',
        ]);
    });

    it('does not treat a falsy payload as a distributed-run text reference', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [],
            events: [{
                kind: 'event', protocolVersion: 1, runId: 'focused-control',
                agentId: 'agent-a', atEpochMs: 1, payload: null,
            }],
        });
        const distributedRun = {
            ...input.distributedRun,
            distributedRunId: 'null',
            manifest: { ...input.distributedRun.manifest, distributedRunId: 'null' },
        };

        expect(deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun,
        }).events).toEqual([]);
    });
});

function adversarialScaleInput(): Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
}> {
    const distributedRunId = 'distributed:scale|界';
    const controlRunId = 'control:scale|界';
    const recipeIds = ['recipe:a|b', 'recipe:a:b', 'מתכון-界'] as const;
    const agentIds = Array.from({ length: SCALE }, (_, index) => {
        if (index === 0) return 'agent:a|b';
        if (index === 1) return 'agent:a:b';
        if (index === 2) return 'agent-\u202Egnul-界';
        return `agent-${String(index).padStart(4, '0')}`;
    });
    const commandIds = Array.from({ length: SCALE }, (_, index) => {
        if (index === 0) return 'command:a|b';
        if (index === 1) return 'command:a:b';
        if (index === 2) return 'command-\u2066exact\u2069-🧪';
        return `command-${String(index).padStart(4, '0')}`;
    });
    const phases = ['stage', 'barrier', 'start', 'cancel'] as const;
    const commandLinks: ControlDistributedRunSnapshot['commandLinks'] =
        commandIds.map((commandId, index) => ({
            phase: phases[index % phases.length]!,
            agentId: agentIds[index]!,
            commandId,
            ...(index % 17 === 0 ? {} : { recipeId: recipeIds[index % recipeIds.length]! }),
            queuedAtEpochMs: 10_000 + index,
        }));
    const commands: ControlRunSnapshot['commands'] = commandIds.map((commandId, index) => ({
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: controlRunId,
            agentId: agentIds[index],
            commandId,
            command: { kind: 'health' },
        },
        queuedAtEpochMs: 10_000 + index,
        dispatchedAtEpochMs: index % 13 === 0 ? undefined : 10_100 + index,
        completedAtEpochMs: index % 19 === 0 ? undefined : 10_200 + index,
        dispatchCount: index % 13 === 0 ? 0 : 1,
    }));
    const results: ControlRunSnapshot['results'] = commandIds.map((commandId, index) => {
        const ok = index % 997 !== 0;
        return {
            kind: 'result',
            protocolVersion: 1,
            runId: controlRunId,
            agentId: agentIds[index]!,
            commandId,
            ok,
            result: {
                commandId,
                kind: 'health',
                status: ok ? 'ok' : 'failed',
                ok,
                startedAtEpochMs: 10_100 + index,
                endedAtEpochMs: 10_200 + index,
                durationMs: (index % 251) + 1,
                ...(ok ? {} : {
                    error: {
                        code: `FAIL_${index}`,
                        message: `Failure ${index} for ${agentIds[index]}.`,
                    },
                }),
            },
            ...(ok ? {} : {
                error: {
                    code: `FAIL_${index}`,
                    message: `Failure ${index} for ${agentIds[index]}.`,
                },
            }),
        };
    });
    const events: ControlRunSnapshot['events'] = Array.from(
        { length: SCALE },
        (_, index) => {
            const isDiagnostic = index % 127 === 0;
            const excluded = index % 23 === 0;
            const payloadLinked = index % 19 === 0;
            return {
                kind: isDiagnostic ? 'diagnostic' : 'event',
                protocolVersion: 1,
                runId: controlRunId,
                agentId: agentIds[index]!,
                atEpochMs: 20_000 + (SCALE - index),
                ...(index % 29 === 0 ? {} : { eventId: `event-${index}` }),
                ...(excluded || payloadLinked
                    ? { commandId: excluded ? `unlinked-${index}` : undefined }
                    : { commandId: commandIds[index] }),
                payload: isDiagnostic
                    ? {
                        diagnosticSchemaVersion: 1,
                        diagnosticTypeId: 'rtc.lane.mismatch',
                        severity: index % 254 === 0 ? 'error' : 'warning',
                        transport: 'messages.rtc',
                        message: `Diagnostic ${index}`,
                        data: {
                            ...(payloadLinked ? { distributedRunId } : {}),
                            expectedLaneId: `lane:${index % 7}`,
                            observedLaneId: `lane|${index % 11}`,
                        },
                    }
                    : {
                        topic: `topic:${index % 31}`,
                        message: `Event ${index}`,
                        ...(payloadLinked ? { distributedRunId } : {}),
                    },
            };
        },
    );
    const distributedRun: ControlDistributedRunSnapshot = {
        distributedRunId,
        controlRunId,
        state: 'failed',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 30_000,
        stagedAtEpochMs: 2_000,
        startedAtEpochMs: 3_000,
        completedAtEpochMs: 30_000,
        targetAgentIds: agentIds,
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            displayName: 'Adversarial indexed monitor scale fixture',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'workspace:界',
                groupId: 'group|exact:界',
            },
            recipes: recipeIds.map((recipeId, index) => ({
                recipeId,
                profile: index === 0 ? 'profile:a|b' : `profile-${index}`,
                required: true,
            })),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds,
                expectedParticipantCount: SCALE,
            },
        },
        commandLinks,
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: SCALE,
                requiredParticipants: SCALE,
                readyParticipants: Math.ceil(SCALE / phases.length),
                passedParticipants: SCALE - 6,
                failedParticipants: 6,
                recipes: recipeIds.length,
                requiredRecipes: recipeIds.length,
                passedRecipes: recipeIds.length - 1,
                failedRecipes: 1,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 2,
            },
            failures: [{
                kind: 'participant',
                key: agentIds[0]!,
                state: 'failed',
                required: true,
                error: { code: 'PARTICIPANT_FAILED', message: 'Adversarial agent failed.' },
            }, {
                kind: 'recipe',
                key: recipeIds[0],
                state: 'failed',
                required: true,
                error: { code: 'RECIPE_FAILED', message: 'Adversarial recipe failed.' },
            }],
        },
    };
    return {
        distributedRun,
        controlRun: {
            runId: controlRunId,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 30_000,
            agents: [],
            commands,
            results,
            events,
            stats: [],
            reports: [],
            heartbeats: [],
        },
    };
}

function focusedInput(input: Readonly<{
    agentIds: readonly string[];
    recipeIds: readonly string[];
    links: ControlDistributedRunSnapshot['commandLinks'];
    results?: ControlRunSnapshot['results'];
    events?: ControlRunSnapshot['events'];
    failures?: ControlDistributedRunSnapshot['rollup']['failures'];
    updatedAtEpochMs?: number;
}>): Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
}> {
    const controlRunId = 'focused-control';
    const distributedRunId = 'focused-distributed';
    const results = input.results ?? [];
    const failures = input.failures ?? [];
    const failed = failures.length > 0 || results.some(result => !result.ok);
    const distributedRun: ControlDistributedRunSnapshot = {
        distributedRunId,
        controlRunId,
        state: failed ? 'failed' : 'running',
        createdAtEpochMs: 0,
        updatedAtEpochMs: input.updatedAtEpochMs ?? 100,
        targetAgentIds: input.agentIds,
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'focused-group',
            },
            recipes: input.recipeIds.map(recipeId => ({ recipeId, required: true })),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: input.agentIds,
                expectedParticipantCount: input.agentIds.length,
            },
        },
        commandLinks: input.links,
        rollup: {
            state: failed ? 'failed' : 'running',
            ok: false,
            summary: {
                participants: input.agentIds.length,
                requiredParticipants: input.agentIds.length,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: failed ? 1 : 0,
                recipes: input.recipeIds.length,
                requiredRecipes: input.recipeIds.length,
                passedRecipes: 0,
                failedRecipes: failed ? 1 : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: failures.length,
            },
            failures,
        },
    };
    return {
        distributedRun,
        controlRun: {
            runId: controlRunId,
            createdAtEpochMs: 0,
            updatedAtEpochMs: input.updatedAtEpochMs ?? 100,
            agents: [],
            commands: input.links.map(link => ({
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: controlRunId,
                    agentId: link.agentId,
                    commandId: link.commandId,
                    command: { kind: 'health' },
                },
                queuedAtEpochMs: link.queuedAtEpochMs,
                dispatchedAtEpochMs: link.queuedAtEpochMs + 1,
                completedAtEpochMs: link.queuedAtEpochMs + 2,
                dispatchCount: 1,
            })),
            results,
            events: input.events ?? [],
            stats: [],
            reports: [],
            heartbeats: [],
        },
    };
}

function focusedTargetResolution(input: Readonly<{
    targetAgentIds: readonly string[];
    roleAssignments: ControlDistributedRunSnapshot['manifest']['roleAssignments'];
}>): NonNullable<ControlDistributedRunSnapshot['targetResolution']> {
    return {
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'focused-group',
        },
        resolvedAtEpochMs: 0,
        staleAfterMs: 30_000,
        targetPolicyMode: 'selected-agents',
        targetAgentIds: input.targetAgentIds,
        roleAssignments: input.roleAssignments ?? [],
        blockers: [],
        summary: {
            agents: input.targetAgentIds.length,
            targetable: input.targetAgentIds.length,
            selected: input.targetAgentIds.length,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {},
        },
    };
}

function singleReadArray<Value>(
    values: readonly Value[],
    label: string,
): readonly Value[] {
    const reads = new Set<string>();
    return new Proxy([...values], {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                if (reads.has(property)) {
                    throw new Error(`${label}[${property}] was read more than once.`);
                }
                reads.add(property);
            }
            return Reflect.get(target, property, receiver);
        },
    });
}

function noReadArray<Value>(
    values: readonly Value[],
    label: string,
): readonly Value[] {
    return new Proxy([...values], {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                throw new Error(`${label}[${property}] was read.`);
            }
            return Reflect.get(target, property, receiver);
        },
    });
}

function focusedResult(
    commandId: string,
    agentId: string,
    ok: boolean,
    endedAtEpochMs: number,
): ControlRunSnapshot['results'][number] {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: 'focused-control',
        agentId,
        commandId,
        ok,
        result: {
            commandId,
            kind: 'health',
            status: ok ? 'ok' : 'failed',
            ok,
            startedAtEpochMs: endedAtEpochMs - 1,
            endedAtEpochMs,
            durationMs: 1,
            ...(ok ? {} : {
                error: { code: 'FOCUSED_FAILURE', message: `${commandId} failed.` },
            }),
        },
        ...(ok ? {} : {
            error: { code: 'FOCUSED_FAILURE', message: `${commandId} failed.` },
        }),
    };
}

function focusedDiagnostic(
    eventId: string | undefined,
    agentId: string,
    atEpochMs: number,
    input: Readonly<{ commandId?: string; distributedRunId?: string }>,
): ControlRunSnapshot['events'][number] {
    return {
        kind: 'diagnostic',
        protocolVersion: 1,
        runId: 'focused-control',
        agentId,
        atEpochMs,
        ...(eventId === undefined ? {} : { eventId }),
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        payload: {
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rtc.focused',
            severity: 'warning',
            transport: 'messages.rtc',
            message: eventId ?? 'fallback diagnostic',
            data: {
                ...(input.distributedRunId === undefined
                    ? {}
                    : { distributedRunId: input.distributedRunId }),
            },
        },
    };
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function twoDimensionalMonitorWork(dimension: number) {
    return {
        monitorDerivationCount: 1,
        reportDerivationCount: 0,
        commandLinkIndexPassCount: 1,
        commandLinkVisitCount: 0,
        controlCommandIndexPassCount: 1,
        controlCommandVisitCount: 0,
        controlResultIndexPassCount: 1,
        controlResultVisitCount: 0,
        controlEventIndexPassCount: 1,
        controlEventVisitCount: 0,
        linkedEventAgentIndexVisitCount: 0,
        failureIndexVisitCount: 0,
        targetAgentIndexPassCount: 1,
        targetAgentVisitCount: dimension,
        recipeSelectionIndexPassCount: 1,
        recipeSelectionVisitCount: dimension,
        roleAssignmentIndexPassCount: 1,
        roleAssignmentVisitCount: 0,
        targetPolicyRoleMembershipVisitCount: 0,
        membershipDescriptorBuildCount: dimension,
        membershipInvertedIndexWriteCount: 0,
        membershipIntersectionCandidateVisitCount: 0,
        recipeTargetCountProjectionVisitCount: dimension,
        retainedMembershipDescriptorCount: dimension,
        retainedRecipeTargetCountCount: dimension,
        commandLinkCompletionProbeCount: 0,
        agentLinkBucketLookupCount: dimension,
        agentEventBucketLookupCount: dimension,
        agentRoleLookupCount: dimension * 2,
        agentLinkProjectionVisitCount: 0,
        agentEventProjectionVisitCount: 0,
        recipeLinkBucketLookupCount: dimension,
        recipeLinkProjectionVisitCount: 0,
        recipeTargetCountLookupCount: dimension,
        linkedAgentExpectedMembershipProbeCount: 0,
        readinessLinkBucketLookupCount: dimension,
        readinessStageLinkProjectionVisitCount: 0,
        timelineCommandLinkProjectionVisitCount: 0,
        diagnosticFailureCandidateVisitCount: 0,
        reportCommandLinkLookupCount: 0,
        reportFallbackCommandLinkIndexPassCount: 0,
        reportFallbackCommandLinkVisitCount: 0,
        reportFallbackCommandPhaseLookupCount: 0,
    };
}
