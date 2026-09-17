import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../../shared-test/rallar-bb-test/control-snapshots.ts';
import { deriveDistributedRunAnalysisReport } from '../../shared-test/rallar-bb-test/distributed-run-analysis/distributed-run-analysis-report.ts';
import { deriveRunVerdictView } from '../../shared-test/rallar-bb-test/distributed-run-analysis/run-verdict-view.ts';
import { deriveDistributedRunMonitor } from '../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    computeDistributedRunCorrelatedFailures,
    createDistributedRunMonitorFailureIndex
} from '../../shared-test/rallar-bb-test/distributed-run-observation/distributed-run-monitor-failure-index.ts';
import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow
} from '../../shared-test/rallar-bb-test/distributed-run-observation/distributed-run-row-contracts.ts';

const SCALE = 5_000;
// A derivation whose work is linear in run size roughly doubles when the run doubles; an agent-by-recipe
// or agent-by-link product quadruples.
const LINEAR_GROWTH_LIMIT = 2.5;
// Whole-object ratchets, originally captured from the pre-index implementation before Task 6A and
// recaptured when strict version-1 diagnostic decoding removed the expectedLaneId, observedLaneId,
// and accepted diagnostic row fields. The report embeds correlated diagnostic rows and the verdict
// embeds their summaries, so all four digests moved with that row contract.
const SCALE_MONITOR_SHA256 = 'c518d6afd9c618b1d437d297edf122e3d9b489266676ca61a00e00ed0e89f22d';
const SCALE_REPORT_SHA256 = '56eb604376089569ba84f9b54d271756b16ed0d46df0854b1f51c4d08a1852bb';
const SCALE_VERDICT_SHA256 = '7543e629a454ed1e871d15547998a359a1761cc878dd85b88a2325f86661119c';
const SCALE_MEMBERSHIP_MONITOR_SHA256 = '22adefedec7e3b9131c975bd691e80799cb5bccc779264d57775770db755cb35';

describe('distributed run monitor indexed derivation', () => {
    it('preserves the complete monitor, report, and verdict observables at 5,000 scale', () => {
        const input = adversarialScaleInput(SCALE);
        const monitor = deriveDistributedRunMonitor(input);
        const report = deriveDistributedRunAnalysisReport({
            ...input,
            monitor,
            snapshotBounds: {
                commands: SCALE,
                results: SCALE,
                events: SCALE
            }
        });
        const verdict = deriveRunVerdictView({
            distributedRun: input.distributedRun,
            monitor,
            report,
            refreshedAtEpochMs: 90_000
        });

        expect(sha256(monitor)).toBe(SCALE_MONITOR_SHA256);
        expect(sha256(report)).toBe(SCALE_REPORT_SHA256);
        expect(sha256(verdict)).toBe(SCALE_VERDICT_SHA256);
    }, 30_000);

    it('reads every raw target, recipe, link, command, result and event once across a 5,000-agent monitor and its report', () => {
        const input = adversarialScaleInput(SCALE);
        const targets = witnessElementReads(input.distributedRun.targetAgentIds);
        const recipes = witnessElementReads(input.distributedRun.manifest.recipes);
        const links = witnessElementReads(input.distributedRun.commandLinks);
        const commands = witnessElementReads(input.controlRun.commands);
        const results = witnessElementReads(input.controlRun.results);
        const events = witnessElementReads(input.controlRun.events);
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            targetAgentIds: targets.values,
            commandLinks: links.values,
            manifest: { ...input.distributedRun.manifest, recipes: recipes.values }
        };
        const controlRun: ControlRunSnapshot = {
            ...input.controlRun,
            commands: commands.values,
            results: results.values,
            events: events.values
        };

        const monitor = deriveDistributedRunMonitor({ distributedRun, controlRun });
        const report = deriveDistributedRunAnalysisReport({ distributedRun, controlRun, monitor });

        expect([targets, recipes, links, commands, results, events].map(toDistinctReadCounts))
            .toEqual(Array.from({ length: 6 }, () => new Set([1])));
        expect(report.nextActions.length).toBeGreaterThan(0);
        expect(report).toEqual(deriveDistributedRunAnalysisReport(input));
    }, 30_000);

    it('grows linearly with a failed run\'s agents, links, results and events', () => {
        expect(computeDerivationGrowth(adversarialScaleInput, SCALE)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }, 30_000);

    it('indexes 5,000 role assignments and expected recipe memberships once', () => {
        const input = adversarialScaleInput(SCALE);
        const recipeIds = input.distributedRun.manifest.recipes.map(
            (selection) => selection.recipeId!
        );
        const roleAssignments = witnessElementReads(input.distributedRun.targetAgentIds.map(
            (agentId, index) => ({
                agentId,
                role: index % 3 === 2 ? 'role:other|界' : 'role:receiver\u202E|界',
                recipeIds: index % 3 === 0
                    ? [recipeIds[0]!]
                    : index % 3 === 1
                    ? []
                    : ['unknown:recipe|界'],
                required: true,
                variables: {}
            })
        ));
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    ...input.distributedRun.manifest.recipes[0]!,
                    role: undefined
                }, {
                    ...input.distributedRun.manifest.recipes[1]!,
                    role: 'role:receiver\u202E|界'
                }, {
                    ...input.distributedRun.manifest.recipes[2]!,
                    role: undefined
                }],
                roleAssignments: roleAssignments.values
            }
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun
        });

        expect(toDistinctReadCounts(roleAssignments)).toEqual(new Set([1]));
        expect(sha256(monitor)).toBe(SCALE_MEMBERSHIP_MONITOR_SHA256);
        expect(monitor.agentProgress[0]?.role).toBe('role:receiver\u202E|界');
        expect(monitor.readiness[0]?.role).toBe('role:receiver\u202E|界');
        expect(monitor.recipeProgress.map((row) => row.targetCount)).toEqual([
            5_000,
            3_334,
            3_333
        ]);
    }, 30_000);

    it('compresses a 2,000 by 2,000 all-unroled membership matrix', () => {
        const dimension = 2_000;

        const monitor = deriveDistributedRunMonitor(allUnroledMatrixInput(dimension));

        expect(monitor.recipeProgress).toHaveLength(dimension);
        expect(monitor.recipeProgress[0]).toMatchObject({
            targetCount: dimension,
            missingCount: dimension
        });
        expect(monitor.recipeProgress.at(-1)).toMatchObject({
            targetCount: dimension,
            missingCount: dimension
        });
        expect(computeDerivationGrowth(allUnroledMatrixInput, dimension)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }, 30_000);

    it('aggregates a 2,000 by 2,000 same-role membership matrix', () => {
        const dimension = 2_000;
        const role = 'matrix-role|\u202E界';
        const matrixInput = (size: number) => sameRoleMatrixInput(size, role);

        const monitor = deriveDistributedRunMonitor(matrixInput(dimension));

        expect(monitor.recipeProgress).toHaveLength(dimension);
        expect(monitor.recipeProgress[0]).toMatchObject({
            targetCount: dimension,
            missingCount: dimension
        });
        expect(monitor.recipeProgress.at(-1)).toMatchObject({
            targetCount: dimension,
            missingCount: dimension
        });
        expect(computeDerivationGrowth(matrixInput, dimension)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }, 30_000);

    it('preserves resolved-empty precedence and duplicate target order', () => {
        const input = focusedInput({
            agentIds: ['agent:duplicate|\u202E界', 'agent:duplicate|\u202E界'],
            recipeIds: ['manifest-role', 'unroled'],
            links: []
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    recipeId: 'manifest-role',
                    role: 'role:manifest|界',
                    required: true,
                    variables: {}
                }, {
                    recipeId: 'resolved-role',
                    role: 'role:resolved|界',
                    required: true,
                    variables: {}
                }, {
                    recipeId: 'unroled',
                    required: true,
                    variables: {}
                }],
                roleAssignments: [{
                    agentId: 'agent:duplicate|\u202E界',
                    role: 'role:manifest|界',
                    recipeIds: ['manifest-role'],
                    required: true,
                    variables: {}
                }]
            },
            targetResolution: focusedTargetResolution({
                targetAgentIds: input.distributedRun.targetAgentIds,
                roleAssignments: []
            })
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun
        });

        expect(monitor.agentProgress).toHaveLength(1);
        expect(monitor.agentProgress[0]?.role).toBeUndefined();
        expect(monitor.readiness.map((row) => [row.agentId, row.role])).toEqual([
            ['agent:duplicate|\u202E界', undefined],
            ['agent:duplicate|\u202E界', undefined]
        ]);
        expect(monitor.recipeProgress.map((row) => [row.recipeId, row.targetCount]))
            .toEqual([
                ['manifest-role', 0],
                ['resolved-role', 0],
                ['unroled', 2]
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
                        variables: {},
                        required: true
                    }]
                })
            },
            controlRun: input.controlRun
        });
        expect(resolvedMonitor.agentProgress[0]?.role).toBe('role:resolved|界');
        expect(resolvedMonitor.recipeProgress.map((row) => [row.recipeId, row.targetCount]))
            .toEqual([
                ['manifest-role', 0],
                ['resolved-role', 2],
                ['unroled', 2]
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
                fallbackAgentId
            ],
            recipeIds: [],
            links: []
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{
                    recipeId: 'recipe:id-only|\u202E界',
                    role: 'role:not-assigned',
                    required: true,
                    variables: {}
                }, {
                    recipeId: 'recipe:duplicate|界',
                    role: matchingRole,
                    required: true,
                    variables: {}
                }, {
                    recipeId: 'recipe:duplicate|界',
                    role: matchingRole,
                    required: true,
                    variables: {}
                }, {
                    recipeId: '',
                    required: true,
                    variables: {}
                }, {
                    recipeId: 'recipe:fallback|界',
                    required: true,
                    variables: {}
                }],
                targetPolicy: {
                    mode: 'role-map',
                    roles: { [matchingRole]: [policyAgentId] },
                    expectedParticipantCount: input.distributedRun.manifest.targetPolicy.expectedParticipantCount
                },
                roleAssignments: [{
                    agentId: assignedAgentId,
                    role: matchingRole,
                    recipeIds: ['recipe:id-only|\u202E界'],
                    variables: {},
                    required: true
                }, {
                    agentId: assignedAgentId,
                    role: matchingRole,
                    recipeIds: [],
                    variables: {},
                    required: true
                }, {
                    agentId: assignedAgentId,
                    role: 'role:third|界',
                    variables: {},
                    recipeIds: [],
                    required: true
                }, {
                    agentId: emptyAgentId,
                    role: '',
                    recipeIds: ['recipe:unknown|界'],
                    variables: {},
                    required: true
                }, {
                    agentId: fallbackAgentId,
                    role: 'role:no-match|界',
                    recipeIds: ['recipe:unknown|界'],
                    variables: {},
                    required: true
                }]
            }
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun
        });

        expect(monitor.agentProgress.find((row) => row.agentId === assignedAgentId)?.role)
            .toBe(`${matchingRole}, ${matchingRole}, role:third|界`);
        expect(monitor.agentProgress.find((row) => row.agentId === emptyAgentId)?.role)
            .toBe('');
        expect(monitor.agentProgress.find((row) => row.agentId === policyAgentId)?.role)
            .toBeUndefined();
        expect(monitor.readiness.map((row) => row.agentId)).toEqual(
            distributedRun.targetAgentIds
        );
        expect(monitor.recipeProgress.map((row) => [
            row.recipeId,
            row.role,
            row.targetCount
        ])).toEqual([
            ['recipe:id-only|\u202E界', 'role:not-assigned', 1],
            ['recipe:duplicate|界', matchingRole, 2],
            ['recipe:duplicate|界', matchingRole, 2],
            ['recipe-4', undefined, 4],
            ['recipe:fallback|界', undefined, 4]
        ]);
    });

    it('counts direct-id and role overlap once and caches duplicate selection intersections', () => {
        const role = 'role:overlap|界';
        const input = focusedInput({
            agentIds: ['overlap-agent', 'overlap-agent', 'role-agent', 'direct-agent'],
            recipeIds: [],
            links: []
        });
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: [{ recipeId: 'shared-recipe', role, variables: {}, required: true }, {
                    recipeId: 'shared-recipe',
                    role,
                    variables: {},
                    required: true
                }],
                roleAssignments: [{
                    agentId: 'overlap-agent',
                    role,
                    recipeIds: ['shared-recipe'],
                    variables: {},
                    required: true
                }, {
                    agentId: 'role-agent',
                    role,
                    recipeIds: [],
                    variables: {},
                    required: true
                }, {
                    agentId: 'direct-agent',
                    role: 'role:other',
                    recipeIds: ['shared-recipe'],
                    variables: {},
                    required: true
                }]
            }
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: input.controlRun
        });

        expect(monitor.recipeProgress.map((row) => [
            row.targetCount,
            row.missingCount
        ])).toEqual([[4, 4], [4, 4]]);
    });

    it('grows linearly when duplicate id-and-role selections and their overlapping agents grow together', () => {
        const size = 2_000;

        const monitor = deriveDistributedRunMonitor(duplicateOverlapInput(size));

        expect(monitor.recipeProgress).toHaveLength(size);
        expect(monitor.recipeProgress.at(-1)).toMatchObject({ targetCount: size, missingCount: size });
        expect(computeDerivationGrowth(duplicateOverlapInput, size)).toBeLessThan(LINEAR_GROWTH_LIMIT);
    }, 30_000);

    it('reads each raw target, recipe selection, role assignment, and command link at most once', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a', 'recipe-b'],
            links: [{
                phase: 'stage',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'command-a',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'agent-b',
                recipeId: 'recipe-b',
                commandId: 'command-b',
                queuedAtEpochMs: 2
            }],
            results: [focusedResult({ commandId: 'command-b', agentId: 'agent-b', ok: false, endedAtEpochMs: 10 })]
        });
        const roleAssignments = [{
            agentId: 'agent-a',
            role: 'role-a',
            recipeIds: ['recipe-a'],
            required: true,
            variables: {}
        }, {
            agentId: 'agent-b',
            role: 'role-b',
            recipeIds: ['recipe-b'],
            required: true,
            variables: {}
        }];
        const distributedRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            targetAgentIds: singleReadArray(input.distributedRun.targetAgentIds, 'targets'),
            commandLinks: singleReadArray(input.distributedRun.commandLinks, 'links'),
            manifest: {
                ...input.distributedRun.manifest,
                recipes: singleReadArray(input.distributedRun.manifest.recipes, 'recipes'),
                roleAssignments: singleReadArray(roleAssignments, 'assignments')
            }
        };

        let report: ReturnType<typeof deriveDistributedRunAnalysisReport> | undefined;
        expect(() => {
            const monitor = deriveDistributedRunMonitor({
                distributedRun,
                controlRun: input.controlRun
            });
            report = deriveDistributedRunAnalysisReport({
                distributedRun,
                controlRun: input.controlRun,
                monitor
            });
        }).not.toThrow();
        expect(report?.firstFailure).toMatchObject({ commandId: 'command-b', category: 'command' });
    });

    it('keeps delimiter-colliding agent and recipe identities isolated', () => {
        const links: ControlDistributedRunSnapshot['commandLinks'] = [{
            phase: 'start',
            agentId: 'agent:a',
            recipeId: 'b',
            commandId: 'command-a',
            queuedAtEpochMs: 1
        }, {
            phase: 'start',
            agentId: 'agent',
            recipeId: 'a:b',
            commandId: 'command-b',
            queuedAtEpochMs: 2
        }, {
            phase: 'start',
            agentId: 'agent|a',
            recipeId: 'b',
            commandId: 'command-c',
            queuedAtEpochMs: 3
        }, {
            phase: 'start',
            agentId: 'agent',
            recipeId: 'a|b',
            commandId: 'command-d',
            queuedAtEpochMs: 4
        }];
        const input = focusedInput({
            agentIds: ['agent:a', 'agent', 'agent|a'],
            recipeIds: ['b', 'a:b', 'a|b'],
            links,
            results: [
                focusedResult({ commandId: 'command-a', agentId: 'agent:a', ok: false, endedAtEpochMs: 10 }),
                focusedResult({ commandId: 'command-b', agentId: 'agent', ok: true, endedAtEpochMs: 11 }),
                focusedResult({ commandId: 'command-c', agentId: 'agent|a', ok: true, endedAtEpochMs: 12 }),
                focusedResult({ commandId: 'command-d', agentId: 'agent', ok: false, endedAtEpochMs: 13 })
            ],
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'focused-control',
                agentId: 'agent:a',
                commandId: 'command-a',
                atEpochMs: 20,
                eventId: 'event-agent-colon',
                payload: { message: 'colon' }
            }, {
                kind: 'event',
                protocolVersion: 1,
                runId: 'focused-control',
                agentId: 'agent',
                commandId: 'command-b',
                atEpochMs: 21,
                eventId: 'event-recipe-colon',
                payload: { message: 'recipe colon' }
            }, {
                kind: 'event',
                protocolVersion: 1,
                runId: 'focused-control',
                agentId: 'agent|a',
                commandId: 'command-c',
                atEpochMs: 22,
                eventId: 'event-agent-pipe',
                payload: { message: 'pipe' }
            }]
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.agentProgress.find((row) => row.agentId === 'agent:a')).toMatchObject({
            failedCommandCount: 1,
            eventCount: 1
        });
        expect(monitor.agentProgress.find((row) => row.agentId === 'agent')).toMatchObject({
            failedCommandCount: 1,
            resultCount: 2,
            eventCount: 1
        });
        expect(monitor.agentProgress.find((row) => row.agentId === 'agent|a')).toMatchObject({
            failedCommandCount: 0,
            eventCount: 1
        });
        expect(monitor.recipeProgress.map((row) => [
            row.recipeId,
            row.passedCount,
            row.failedCount
        ])).toEqual([
            ['b', 1, 1],
            ['a:b', 1, 0],
            ['a|b', 0, 1]
        ]);
    });

    it('preserves undefined versus empty recipe links and absent versus empty control truth', () => {
        const links: ControlDistributedRunSnapshot['commandLinks'] = [{
            phase: 'start',
            agentId: 'agent-a',
            recipeId: undefined,
            commandId: 'undefined-recipe',
            queuedAtEpochMs: 1
        }, {
            phase: 'start',
            agentId: 'agent-b',
            recipeId: '',
            commandId: 'empty-recipe',
            queuedAtEpochMs: 2
        }];
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['only-recipe'],
            links,
            results: [
                focusedResult({ commandId: 'undefined-recipe', agentId: 'agent-a', ok: true, endedAtEpochMs: 10 }),
                focusedResult({ commandId: 'empty-recipe', agentId: 'agent-b', ok: true, endedAtEpochMs: 11 })
            ]
        });
        const monitor = deriveDistributedRunMonitor(input);
        expect(monitor.recipeProgress[0]).toMatchObject({
            recipeId: 'only-recipe',
            targetCount: 2,
            passedCount: 1,
            missingCount: 1
        });

        const withoutControl = deriveDistributedRunMonitor({
            distributedRun: input.distributedRun
        });
        const withEmptyControl = deriveDistributedRunMonitor({
            distributedRun: input.distributedRun,
            controlRun: {
                ...input.controlRun,
                commands: [],
                results: [],
                events: []
            }
        });
        expect(withoutControl).toEqual(withEmptyControl);
    });

    it('preserves last-result lookup while counting every linked result envelope', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b', 'agent-c'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'command-a',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'agent-b',
                recipeId: 'recipe-a',
                commandId: 'command-b',
                queuedAtEpochMs: 2
            }, {
                phase: 'start',
                agentId: 'agent-c',
                recipeId: 'recipe-a',
                commandId: 'command-c',
                queuedAtEpochMs: 3
            }],
            results: [
                focusedResult({ commandId: 'command-a', agentId: 'agent-a', ok: true, endedAtEpochMs: 10 }),
                focusedResult({ commandId: 'command-b', agentId: 'agent-b', ok: false, endedAtEpochMs: 11 }),
                focusedResult({ commandId: 'command-b', agentId: 'agent-b', ok: true, endedAtEpochMs: 12 })
            ]
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.resultCounts).toEqual({ total: 3, ok: 2, failed: 1 });
        expect(monitor.agentProgress.reduce((sum, row) => sum + row.resultCount, 0)).toBe(2);
        expect(monitor.agentProgress.find((row) => row.agentId === 'agent-b')).toMatchObject({
            failedCommandCount: 0,
            execution: 'passed'
        });
    });

    it('keeps first-link failure-action semantics when command IDs are duplicated', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'duplicate-command',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'agent-b',
                recipeId: 'recipe-a',
                commandId: 'duplicate-command',
                queuedAtEpochMs: 2
            }],
            results: [focusedResult({
                commandId: 'duplicate-command',
                agentId: 'agent-a',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const monitor = deriveDistributedRunMonitor(input);
        const report = deriveDistributedRunAnalysisReport({ ...input, monitor });

        expect(report.nextActions.find((action) => action.category === 'command')?.nextAction)
            .toContain('recipe-load output');
    });

    it('reuses the monitor command-link index for every report derived from that monitor', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'local-report-lookup',
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: 'local-report-lookup',
                agentId: 'agent-a',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const links = witnessElementReads(input.distributedRun.commandLinks);
        const observedInput = {
            ...input,
            distributedRun: { ...input.distributedRun, commandLinks: links.values }
        };
        const monitor = deriveDistributedRunMonitor(observedInput);

        const firstReport = deriveDistributedRunAnalysisReport({ ...observedInput, monitor });
        const secondReport = deriveDistributedRunAnalysisReport({ ...observedInput, monitor });

        expect(links.readsPerElement()).toEqual([1]);
        expect(secondReport).toEqual(firstReport);
        expect(firstReport.nextActions.find((action) => action.category === 'command')?.nextAction)
            .toContain('recipe-load output');
    });

    it('falls back to report command links when a monitor came from another run object', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'cross-snapshot-command',
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: 'cross-snapshot-command',
                agentId: 'agent-a',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const monitor = deriveDistributedRunMonitor(input);
        const reportRun: ControlDistributedRunSnapshot = {
            ...input.distributedRun,
            commandLinks: [{
                ...input.distributedRun.commandLinks[0]!,
                phase: 'start'
            }]
        };
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor: { ...monitor }
        });

        expect(deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor
        })).toEqual(headReport);
        expect(headReport.nextActions.find((action) => action.category === 'command')?.nextAction)
            .toContain('composite drilldown');
    });

    it('falls back when the same run object receives a different command-links array', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'stage',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'replaced-links-command',
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: 'replaced-links-command',
                agentId: 'agent-a',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const mutableRun = { ...input.distributedRun };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: mutableRun,
            controlRun: input.controlRun
        });
        Object.assign(mutableRun, {
            commandLinks: [{
                ...input.distributedRun.commandLinks[0]!,
                phase: 'start'
            }]
        });
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: mutableRun,
            monitor: { ...monitor }
        });

        expect(deriveDistributedRunAnalysisReport({
            distributedRun: mutableRun,
            monitor
        })).toEqual(headReport);
        expect(headReport.nextActions.find((action) => action.category === 'command')?.nextAction)
            .toContain('composite drilldown');
    });

    it('does not index 5,000 fallback links when a cross-run monitor has no failures', () => {
        const scaleInput = adversarialScaleInput(SCALE);
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: []
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const reportRun: ControlDistributedRunSnapshot = {
            ...scaleInput.distributedRun,
            commandLinks: noReadArray(
                scaleInput.distributedRun.commandLinks,
                'no-failure fallback links'
            )
        };
        let report: ReturnType<typeof deriveDistributedRunAnalysisReport> | undefined;

        expect(() => {
            report = deriveDistributedRunAnalysisReport({
                distributedRun: reportRun,
                monitor: suppliedMonitor
            });
        }).not.toThrow();
        expect(report?.distributedRunId).toBe(scaleInput.distributedRun.distributedRunId);
    });

    it('lazily indexes 5,000 fallback links once for one cross-run command failure', () => {
        const scaleInput = adversarialScaleInput(SCALE);
        const failedCommandId = scaleInput.distributedRun.commandLinks.at(-1)!.commandId;
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: [{
                phase: 'stage',
                agentId: 'supplied-agent',
                recipeId: 'supplied-recipe',
                commandId: failedCommandId,
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: failedCommandId,
                agentId: 'supplied-agent',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: scaleInput.distributedRun,
            monitor: { ...suppliedMonitor }
        });
        const links = witnessElementReads(scaleInput.distributedRun.commandLinks);
        const reportRun: ControlDistributedRunSnapshot = {
            ...scaleInput.distributedRun,
            commandLinks: links.values
        };

        const report = deriveDistributedRunAnalysisReport({
            distributedRun: reportRun,
            monitor: suppliedMonitor
        });

        expect(report).toEqual(headReport);
        expect(toDistinctReadCounts(links)).toEqual(new Set([1]));
    }, 30_000);

    it('preserves verdict output when a caller supplies a monitor but omits the report', () => {
        const verdictInput = focusedInput({
            agentIds: ['verdict-agent'],
            recipeIds: ['verdict-recipe'],
            links: []
        });
        const suppliedMonitorInput = focusedInput({
            agentIds: ['supplied-agent'],
            recipeIds: ['supplied-recipe'],
            links: [{
                phase: 'start',
                agentId: 'supplied-agent',
                recipeId: 'supplied-recipe',
                commandId: 'supplied-failure',
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: 'supplied-failure',
                agentId: 'supplied-agent',
                ok: false,
                endedAtEpochMs: 10
            })]
        });
        const suppliedMonitor = deriveDistributedRunMonitor(suppliedMonitorInput);
        const headReport = deriveDistributedRunAnalysisReport({
            distributedRun: verdictInput.distributedRun
        });

        expect(deriveRunVerdictView({
            distributedRun: verdictInput.distributedRun,
            monitor: suppliedMonitor,
            refreshedAtEpochMs: 123
        })).toEqual(deriveRunVerdictView({
            distributedRun: verdictInput.distributedRun,
            monitor: suppliedMonitor,
            report: headReport,
            refreshedAtEpochMs: 123
        }));
    });

    it('preserves diagnostic correlation order, duplicate keys, and inclusive time bounds', () => {
        const distributedRunId = 'focused-distributed';
        const input = focusedInput({
            agentIds: ['failure-agent', 'other-agent', 'boundary-agent', 'duplicate-key'],
            recipeIds: ['recipe-a'],
            updatedAtEpochMs: 30_000,
            links: [{
                phase: 'start',
                agentId: 'failure-agent',
                recipeId: 'recipe-a',
                commandId: 'exact-command',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'boundary-agent',
                recipeId: 'recipe-a',
                commandId: 'near-15000',
                queuedAtEpochMs: 2
            }, {
                phase: 'start',
                agentId: 'boundary-agent',
                recipeId: 'recipe-a',
                commandId: 'far-15001',
                queuedAtEpochMs: 3
            }, {
                phase: 'start',
                agentId: 'duplicate-key',
                recipeId: 'recipe-a',
                commandId: 'duplicate-key',
                queuedAtEpochMs: 4
            }],
            results: [
                focusedResult({
                    commandId: 'exact-command',
                    agentId: 'failure-agent',
                    ok: false,
                    endedAtEpochMs: 12_000
                }),
                focusedResult({
                    commandId: 'near-15000',
                    agentId: 'boundary-agent',
                    ok: false,
                    endedAtEpochMs: 10_000
                }),
                focusedResult({ commandId: 'far-15001', agentId: 'boundary-agent', ok: false, endedAtEpochMs: 9_999 })
            ],
            failures: [{
                kind: 'participant',
                key: 'duplicate-key',
                state: 'failed'
            }, {
                kind: 'recipe',
                key: 'duplicate-key',
                state: 'failed'
            }],
            events: [
                focusedDiagnostic({
                    eventId: 'diagnostic-exact',
                    agentId: 'other-agent',
                    atEpochMs: 40_000,
                    commandId: 'exact-command',
                    distributedRunId
                }),
                focusedDiagnostic({
                    eventId: 'diagnostic-duplicates',
                    agentId: 'other-agent',
                    atEpochMs: 40_001,
                    commandId: 'duplicate-key',
                    distributedRunId
                }),
                focusedDiagnostic({
                    eventId: 'diagnostic-boundary',
                    agentId: 'boundary-agent',
                    atEpochMs: 25_000,
                    distributedRunId
                })
            ]
        });

        const diagnostics = new Map(
            deriveDistributedRunMonitor(input)
                .runtimeDiagnostics.map((row) => [row.eventId, row.correlatedFailureKeys])
        );

        expect(diagnostics.get('diagnostic-exact')).toContain('exact-command');
        expect(diagnostics.get('diagnostic-duplicates')).toEqual([
            'duplicate-key',
            'duplicate-key'
        ]);
        expect(diagnostics.get('diagnostic-boundary')).toContain('near-15000');
        expect(diagnostics.get('diagnostic-boundary')).not.toContain('far-15001');
    });

    it('does not time-correlate a diagnostic with an empty agent identity', () => {
        const input = focusedInput({
            agentIds: [''],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start',
                agentId: '',
                recipeId: 'recipe-a',
                commandId: 'empty-agent-failure',
                queuedAtEpochMs: 1
            }],
            results: [focusedResult({
                commandId: 'empty-agent-failure',
                agentId: '',
                ok: false,
                endedAtEpochMs: 10_000
            })],
            events: [focusedDiagnostic({
                eventId: 'empty-agent-diagnostic',
                agentId: '',
                atEpochMs: 10_001,
                distributedRunId: 'focused-distributed'
            })]
        });

        expect(
            deriveDistributedRunMonitor(input).runtimeDiagnostics[0]
                ?.correlatedFailureKeys
        ).toEqual([]);
    });

    it('does not time-correlate non-finite diagnostic or failure timestamps', () => {
        const input = focusedInput({
            agentIds: ['nan-failure-agent', 'nan-diagnostic-agent'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start',
                agentId: 'nan-failure-agent',
                recipeId: 'recipe-a',
                commandId: 'nan-failure',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'nan-diagnostic-agent',
                recipeId: 'recipe-a',
                commandId: 'finite-failure',
                queuedAtEpochMs: 2
            }],
            results: [
                focusedResult({
                    commandId: 'nan-failure',
                    agentId: 'nan-failure-agent',
                    ok: false,
                    endedAtEpochMs: Number.NaN
                }),
                focusedResult({
                    commandId: 'finite-failure',
                    agentId: 'nan-diagnostic-agent',
                    ok: false,
                    endedAtEpochMs: 10_000
                })
            ],
            events: [
                focusedDiagnostic({
                    eventId: 'finite-diagnostic',
                    agentId: 'nan-failure-agent',
                    atEpochMs: 10_000,
                    distributedRunId: 'focused-distributed'
                }),
                focusedDiagnostic({
                    eventId: 'nan-diagnostic',
                    agentId: 'nan-diagnostic-agent',
                    atEpochMs: Number.NaN,
                    distributedRunId: 'focused-distributed'
                })
            ]
        });

        expect(deriveDistributedRunMonitor(input).runtimeDiagnostics.map((row) => [row.eventId, row.correlatedFailureKeys])).toEqual([
            ['finite-diagnostic', []],
            ['nan-diagnostic', []]
        ]);
    });

    it('keeps event fallback indexes post-sort and diagnostic indexes pre-sort', () => {
        const input = focusedInput({
            agentIds: ['agent-a', 'agent-b'],
            recipeIds: ['recipe-a'],
            links: [{
                phase: 'start',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'command-a',
                queuedAtEpochMs: 1
            }, {
                phase: 'start',
                agentId: 'agent-b',
                recipeId: 'recipe-a',
                commandId: 'command-b',
                queuedAtEpochMs: 2
            }],
            events: [
                focusedDiagnostic({ agentId: 'agent-a', atEpochMs: 200, commandId: 'command-a' }),
                focusedDiagnostic({ agentId: 'agent-b', atEpochMs: 100, commandId: 'command-b' })
            ]
        });

        const monitor = deriveDistributedRunMonitor(input);

        expect(monitor.events.map((row) => row.eventId)).toEqual([
            'agent-b-command-b-0',
            'agent-a-command-a-1'
        ]);
        expect(monitor.runtimeDiagnostics.map((row) => row.eventId)).toEqual([
            'agent-b-command-b-1',
            'agent-a-command-a-0'
        ]);
    });

    it('does not treat a falsy payload as a distributed-run text reference', () => {
        const input = focusedInput({
            agentIds: ['agent-a'],
            recipeIds: ['recipe-a'],
            links: [],
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'focused-control',
                agentId: 'agent-a',
                atEpochMs: 1,
                payload: null
            }]
        });
        const distributedRun = {
            ...input.distributedRun,
            distributedRunId: 'null',
            manifest: { ...input.distributedRun.manifest, distributedRunId: 'null' }
        };

        expect(
            deriveDistributedRunMonitor({
                distributedRun,
                controlRun: input.controlRun
            }).events
        ).toEqual([]);
    });
});

describe('distributed run monitor failure index', () => {
    it('correlates a diagnostic by reading its time window, not the agent\'s whole failure history', () => {
        const shorter = correlateLatestFailureWindow(2_500);
        const longer = correlateLatestFailureWindow(5_000);

        expect([shorter.failureKeys.length, longer.failureKeys.length]).toEqual([31, 31]);
        expect(longer.failureKeys.at(-1)).toBe('failure-4999');
        expect(longer.bucketReads - shorter.bucketReads).toBeLessThanOrEqual(2);
    });
});

function adversarialScaleInput(scale: number): Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
}> {
    const distributedRunId = 'distributed:scale|界';
    const controlRunId = 'control:scale|界';
    const recipeIds = ['recipe:a|b', 'recipe:a:b', 'מתכון-界'] as const;
    const agentIds = Array.from({ length: scale }, (_, index) => {
        if (index === 0) {
            return 'agent:a|b';
        }
        if (index === 1) {
            return 'agent:a:b';
        }
        if (index === 2) {
            return 'agent-\u202Egnul-界';
        }
        return `agent-${String(index).padStart(4, '0')}`;
    });
    const commandIds = Array.from({ length: scale }, (_, index) => {
        if (index === 0) {
            return 'command:a|b';
        }
        if (index === 1) {
            return 'command:a:b';
        }
        if (index === 2) {
            return 'command-\u2066exact\u2069-🧪';
        }
        return `command-${String(index).padStart(4, '0')}`;
    });
    const phases = ['stage', 'barrier', 'start', 'cancel'] as const;
    const commandLinks: ControlDistributedRunSnapshot['commandLinks'] = commandIds.map((commandId, index) => ({
        phase: phases[index % phases.length]!,
        agentId: agentIds[index]!,
        commandId,
        ...(index % 17 === 0 ? {} : { recipeId: recipeIds[index % recipeIds.length]! }),
        queuedAtEpochMs: 10_000 + index
    }));
    const commands: ControlRunSnapshot['commands'] = commandIds.map((commandId, index) => ({
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId: controlRunId,
            agentId: agentIds[index],
            commandId,
            command: { kind: 'health' }
        },
        queuedAtEpochMs: 10_000 + index,
        dispatchedAtEpochMs: index % 13 === 0 ? undefined : 10_100 + index,
        completedAtEpochMs: index % 19 === 0 ? undefined : 10_200 + index,
        dispatchCount: index % 13 === 0 ? 0 : 1
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
                        message: `Failure ${index} for ${agentIds[index]}.`
                    }
                })
            },
            ...(ok ? {} : {
                error: {
                    code: `FAIL_${index}`,
                    message: `Failure ${index} for ${agentIds[index]}.`
                }
            })
        };
    });
    const events: ControlRunSnapshot['events'] = Array.from(
        { length: scale },
        (_, index) => {
            const isDiagnostic = index % 127 === 0;
            const excluded = index % 23 === 0;
            const payloadLinked = index % 19 === 0;
            return {
                kind: isDiagnostic ? 'diagnostic' : 'event',
                protocolVersion: 1,
                runId: controlRunId,
                agentId: agentIds[index]!,
                atEpochMs: 20_000 + (scale - index),
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
                            laneId: `lane:${index % 7}`
                        }
                    }
                    : {
                        topic: `topic:${index % 31}`,
                        message: `Event ${index}`,
                        ...(payloadLinked ? { distributedRunId } : {})
                    }
            };
        }
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
                groupId: 'group|exact:界'
            },
            recipes: recipeIds.map((recipeId, index) => ({
                recipeId,
                profile: index === 0 ? 'profile:a|b' : `profile-${index}`,
                required: true,
                variables: {}
            })),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds,
                expectedParticipantCount: scale
            },
            variables: {},
            roleAssignments: [],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false },
            startMode: 'manual',
            groupAssertions: [],
            metadata: {}
        },
        commandLinks,
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: scale,
                readyParticipants: Math.ceil(scale / phases.length),
                passedParticipants: scale - 6,
                failedParticipants: 6,
                recipes: recipeIds.length,
                passedRecipes: recipeIds.length - 1,
                failedRecipes: 1,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 2
            },
            failures: [{
                kind: 'participant',
                key: agentIds[0]!,
                state: 'failed',
                error: { code: 'PARTICIPANT_FAILED', message: 'Adversarial agent failed.' }
            }, {
                kind: 'recipe',
                key: recipeIds[0],
                state: 'failed',
                error: { code: 'RECIPE_FAILED', message: 'Adversarial recipe failed.' }
            }]
        }
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
            heartbeats: []
        }
    };
}

function focusedInput(
    input: Readonly<{
        agentIds: readonly string[];
        recipeIds: readonly string[];
        links: ControlDistributedRunSnapshot['commandLinks'];
        results?: ControlRunSnapshot['results'];
        events?: ControlRunSnapshot['events'];
        failures?: ControlDistributedRunSnapshot['rollup']['failures'];
        updatedAtEpochMs?: number;
    }>
): Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
}> {
    const controlRunId = 'focused-control';
    const distributedRunId = 'focused-distributed';
    const results = input.results ?? [];
    const failures = input.failures ?? [];
    const failed = failures.length > 0 || results.some((result) => !result.ok);
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
                groupId: 'focused-group'
            },
            recipes: input.recipeIds.map((recipeId) => ({ recipeId, required: true, variables: {} })),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: input.agentIds,
                expectedParticipantCount: input.agentIds.length
            },
            variables: {},
            roleAssignments: [],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false },
            startMode: 'manual',
            groupAssertions: [],
            metadata: {}
        },
        commandLinks: input.links,
        rollup: {
            state: failed ? 'failed' : 'running',
            ok: false,
            summary: {
                participants: input.agentIds.length,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: failed ? 1 : 0,
                recipes: input.recipeIds.length,
                passedRecipes: 0,
                failedRecipes: failed ? 1 : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: failures.length
            },
            failures
        }
    };
    return {
        distributedRun,
        controlRun: {
            runId: controlRunId,
            createdAtEpochMs: 0,
            updatedAtEpochMs: input.updatedAtEpochMs ?? 100,
            agents: [],
            commands: input.links.map((link) => ({
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: controlRunId,
                    agentId: link.agentId,
                    commandId: link.commandId,
                    command: { kind: 'health' }
                },
                queuedAtEpochMs: link.queuedAtEpochMs,
                dispatchedAtEpochMs: link.queuedAtEpochMs + 1,
                completedAtEpochMs: link.queuedAtEpochMs + 2,
                dispatchCount: 1
            })),
            results,
            events: input.events ?? [],
            stats: [],
            reports: [],
            heartbeats: []
        }
    };
}

function focusedTargetResolution(
    input: Readonly<{
        targetAgentIds: readonly string[];
        roleAssignments: ControlDistributedRunSnapshot['manifest']['roleAssignments'];
    }>
): NonNullable<ControlDistributedRunSnapshot['targetResolution']> {
    return {
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'focused-group'
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
            assertionCapabilityBlockedAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {}
        }
    };
}

function singleReadArray<Value>(
    values: readonly Value[],
    label: string
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
        }
    });
}

function noReadArray<Value>(
    values: readonly Value[],
    label: string
): readonly Value[] {
    return new Proxy([...values], {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                throw new Error(`${label}[${property}] was read.`);
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

interface FocusedResultInput {
    readonly commandId: string;
    readonly agentId: string;
    readonly ok: boolean;
    readonly endedAtEpochMs: number;
}

function focusedResult(
    { commandId, agentId, ok, endedAtEpochMs }: FocusedResultInput
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
                error: { code: 'FOCUSED_FAILURE', message: `${commandId} failed.` }
            })
        },
        ...(ok ? {} : {
            error: { code: 'FOCUSED_FAILURE', message: `${commandId} failed.` }
        })
    };
}

interface FocusedDiagnosticInput {
    /** Absent to exercise the diagnostic row's fallback identity. */
    readonly eventId?: string;
    readonly agentId: string;
    readonly atEpochMs: number;
    /** Absent when the diagnostic names no command. */
    readonly commandId?: string;
    /** Absent when the diagnostic payload does not reference the distributed run. */
    readonly distributedRunId?: string;
}

function focusedDiagnostic(
    input: FocusedDiagnosticInput
): ControlRunSnapshot['events'][number] {
    return {
        kind: 'diagnostic',
        protocolVersion: 1,
        runId: 'focused-control',
        agentId: input.agentId,
        atEpochMs: input.atEpochMs,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        payload: {
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rtc.focused',
            severity: 'warning',
            transport: 'messages.rtc',
            message: input.eventId ?? 'fallback diagnostic',
            data: {
                ...(input.distributedRunId === undefined
                    ? {}
                    : { distributedRunId: input.distributedRunId })
            }
        }
    };
}

function sha256(value: object): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

type DerivationInput = Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
}>;

interface ElementReads {
    readonly readsPerElement: () => readonly number[];
}

interface ElementReadWitness<Value> extends ElementReads {
    readonly values: readonly Value[];
}

interface OperationCounter {
    operations: number;
}

interface FailureWindowCorrelation {
    readonly failureKeys: readonly string[];
    readonly bucketReads: number;
}

function allUnroledMatrixInput(dimension: number): DerivationInput {
    return focusedInput({
        agentIds: Array.from({ length: dimension }, (_, index) => `matrix-agent-${index}`),
        recipeIds: Array.from({ length: dimension }, (_, index) => `matrix-recipe-${index}`),
        links: []
    });
}

function sameRoleMatrixInput(dimension: number, role: string): DerivationInput {
    const agentIds = Array.from({ length: dimension }, (_, index) => `role-matrix-agent-${index}`);
    const input = focusedInput({
        agentIds,
        recipeIds: Array.from({ length: dimension }, (_, index) => `role-matrix-recipe-${index}`),
        links: []
    });
    return {
        ...input,
        distributedRun: {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: input.distributedRun.manifest.recipes.map((selection) => ({ ...selection, role })),
                roleAssignments: agentIds.map((agentId) => ({
                    agentId,
                    role,
                    recipeIds: [],
                    required: true,
                    variables: {}
                }))
            }
        }
    };
}

/** Every selection repeats one recipe id and role, and every agent is assigned both. */
function duplicateOverlapInput(size: number): DerivationInput {
    const role = 'role:overlap|界';
    const agentIds = Array.from({ length: size }, (_, index) => `overlap-agent-${index}`);
    const input = focusedInput({ agentIds, recipeIds: [], links: [] });
    return {
        ...input,
        distributedRun: {
            ...input.distributedRun,
            manifest: {
                ...input.distributedRun.manifest,
                recipes: Array.from({ length: size }, () => ({
                    recipeId: 'shared-recipe',
                    role,
                    required: true,
                    variables: {}
                })),
                roleAssignments: agentIds.map((agentId) => ({
                    agentId,
                    role,
                    recipeIds: ['shared-recipe'],
                    required: true,
                    variables: {}
                }))
            }
        }
    };
}

function witnessElementReads<Value>(values: readonly Value[]): ElementReadWitness<Value> {
    const reads = values.map(() => 0);
    return {
        values: new Proxy([...values], {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                    const position = Number(property);
                    reads[position] = (reads[position] ?? 0) + 1;
                }
                return Reflect.get(target, property, receiver);
            }
        }),
        readsPerElement: () => [...reads]
    };
}

function toDistinctReadCounts(witness: ElementReads): ReadonlySet<number> {
    return new Set(witness.readsPerElement());
}

/** The operations a monitor and its report make at `size`, relative to half that size. */
function computeDerivationGrowth(inputAtSize: (size: number) => DerivationInput, size: number): number {
    return countDerivationOperations(inputAtSize(size)) / countDerivationOperations(inputAtSize(size / 2));
}

/** Property reads on the input graph plus Map and Set operations while a monitor and its report are derived. */
function countDerivationOperations(input: DerivationInput): number {
    const counter: OperationCounter = { operations: 0 };
    const observedInput = toReadCountingInput(input, counter);
    const restoreCollections = countKeyedCollectionOperations(counter);
    try {
        const monitor = deriveDistributedRunMonitor(observedInput);
        deriveDistributedRunAnalysisReport({ ...observedInput, monitor });
    }
    finally {
        restoreCollections();
    }
    return counter.operations;
}

/** Nested objects keep one proxy each, so identity-keyed reuse behaves as it does for the raw input. */
function toReadCountingInput(input: DerivationInput, counter: OperationCounter): DerivationInput {
    const proxies = new WeakMap<object, object>();
    const handler: ProxyHandler<object> = {
        get(target, property, receiver) {
            counter.operations += 1;
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'object' || value === null) {
                return value;
            }
            const proxy = proxies.get(value) ?? new Proxy(value, handler);
            proxies.set(value, proxy);
            return proxy;
        }
    };
    return new Proxy<DerivationInput>(input, handler);
}

/** Counts Map and Set reads and writes until the returned function restores the original methods. */
function countKeyedCollectionOperations(counter: OperationCounter): () => void {
    const { get: mapGet, set: mapSet, has: mapHas } = Map.prototype;
    const { add: setAdd, has: setHas } = Set.prototype;
    Map.prototype.get = function (key) {
        counter.operations += 1;
        return mapGet.call(this, key);
    };
    Map.prototype.set = function (key, value) {
        counter.operations += 1;
        return mapSet.call(this, key, value);
    };
    Map.prototype.has = function (key) {
        counter.operations += 1;
        return mapHas.call(this, key);
    };
    Set.prototype.add = function (value) {
        counter.operations += 1;
        return setAdd.call(this, value);
    };
    Set.prototype.has = function (value) {
        counter.operations += 1;
        return setHas.call(this, value);
    };
    return () => {
        Object.assign(Map.prototype, { get: mapGet, set: mapSet, has: mapHas });
        Object.assign(Set.prototype, { add: setAdd, has: setHas });
    };
}

/** Correlates one diagnostic whose window holds the last 31 of `failureCount` one-second-apart failures on its agent. */
function correlateLatestFailureWindow(failureCount: number): FailureWindowCorrelation {
    const failures: DistributedRunFailureRow[] = Array.from({ length: failureCount }, (_, position) => ({
        kind: 'command',
        key: `failure-${position}`,
        message: `Failure ${position}.`,
        agentId: 'history-agent',
        atEpochMs: position * 1_000
    }));
    const index = createDistributedRunMonitorFailureIndex(failures);
    const bucket = witnessElementReads(index.timedPositionsByAgentId.get('history-agent') ?? []);
    const correlated = computeDistributedRunCorrelatedFailures(windowDiagnostic((failureCount - 16) * 1_000), {
        ...index,
        timedPositionsByAgentId: new Map([['history-agent', bucket.values]])
    });
    return {
        failureKeys: correlated.failureKeys,
        bucketReads: bucket.readsPerElement().reduce((total, reads) => total + reads, 0)
    };
}

function windowDiagnostic(atEpochMs: number): Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> {
    return {
        eventId: 'window-diagnostic',
        atEpochMs,
        severity: 'warning',
        agentId: 'history-agent',
        topic: 'rtc',
        diagnosticTypeId: 'rtc.window',
        message: 'Window diagnostic.',
        summary: 'Window diagnostic.',
        payloadSummary: ''
    };
}
