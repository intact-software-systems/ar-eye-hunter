import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../../apps/rallar-black-box/src/control-run-manager.ts';
import * as distributedRecipeCompatibility from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    computeDistributedRunFailureEvidenceDestinations,
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveDistributedRunWarningRegressionReport,
    type DistributedRecipeCatalogItem,
    type DistributedRunFailureRow
} from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import * as sharedDistributedRecipes from '../../../shared-test/rallar-bb-test/mod.ts';
import {
    createRallarBlackBoxTestRuntime,
    deriveAdvancedDiagnosticHandoffTargets as deriveSharedAdvancedDiagnosticHandoffTargets
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { distributedArtifactBundle, distributedControlRun, distributedRun } from './distributed-run-fixture.ts';

describe('distributed recipes monitor', () => {
    it('derives monitor roles from server target resolution', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun: {
                ...distributedRun,
                manifest: {
                    ...distributedRun.manifest,
                    roleAssignments: [],
                    roleAssignmentPolicy: {
                        mode: 'ordered-targets',
                        pattern: 'one-sender-many-receivers',
                        orderBy: 'agent-id'
                    }
                },
                targetResolution: {
                    group: distributedRun.manifest.group,
                    resolvedAtEpochMs: 1_050,
                    staleAfterMs: 30_000,
                    targetPolicyMode: 'all-online-group-members',
                    targetAgentIds: ['agent-a', 'agent-b'],
                    roleAssignments: [
                        { agentId: 'agent-a', role: 'sender', recipeIds: [], required: true, variables: {} },
                        { agentId: 'agent-b', role: 'receiver', recipeIds: [], required: true, variables: {} }
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
                        assertionCapabilityBlockedAgents: 0,
                        agentsWithoutIdentity: 0,
                        roleCounts: { receiver: 1, sender: 1 },
                        regions: {},
                        providers: {}
                    }
                }
            },
            controlRun: distributedControlRun
        });

        expect(monitor.agentProgress.map((row) => [row.agentId, row.role])).toEqual([
            ['agent-a', 'sender'],
            ['agent-b', 'receiver']
        ]);
    });

    it('derives distributed run monitor evidence from command links and control run snapshots', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle
        });

        expect(monitor.commandCounts).toMatchObject({
            total: 4,
            stage: 2,
            start: 2,
            completed: 4,
            failed: 1,
            pending: 0
        });
        expect(monitor.resultCounts).toEqual({ total: 4, ok: 3, failed: 1 });
        expect(monitor.diagnosticCounts.total).toBe(0);
        expect(monitor.artifact.status).toBe('valid');
        expect(monitor.readiness.map((row) => [row.agentId, row.status])).toEqual([
            ['agent-a', 'ready'],
            ['agent-b', 'ready']
        ]);
        expect(monitor.agentProgress.map((row) => [row.agentId, row.readiness, row.execution])).toEqual([
            ['agent-a', 'ready', 'passed'],
            ['agent-b', 'ready', 'failed']
        ]);
        expect(monitor.recipeProgress[0]).toMatchObject({
            recipeId: 'health-only',
            passedCount: 1,
            failedCount: 1
        });
        expect(monitor.events.map((event) => event.summary)).toEqual(['payload received']);
        expect(monitor.events[0].payloadSummary).toContain('topic=message.received');
        expect(monitor.failures.map((failure) => failure.code)).toContain('ASSERTION_FAILED');
        expect(monitor.timeline.map((item) => item.label)).toContain('result failed');
    });

    it('exports deterministic selected-failure evidence from the app compatibility barrel', () => {
        expect(Reflect.get(
            distributedRecipeCompatibility,
            'computeDistributedRunFailureEvidenceDestinations'
        )).toBeTypeOf('function');
        expect(computeDistributedRunFailureEvidenceDestinations).toBe(
            sharedDistributedRecipes.computeDistributedRunFailureEvidenceDestinations
        );
    });

    it('exports deterministic Advanced diagnostic handoffs from the app compatibility barrel', () => {
        const compatibilityExport = Reflect.get(
            distributedRecipeCompatibility,
            'deriveAdvancedDiagnosticHandoffTargets'
        );

        expect(compatibilityExport).toBeTypeOf('function');
        expect(compatibilityExport).toBe(deriveSharedAdvancedDiagnosticHandoffTargets);
    });

    it('derives available evidence destinations for each selected failure instead of the first failure', () => {
        const evidenceRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            error: {
                code: 'RUN_FAILED',
                message: 'Distributed orchestration failed.'
            },
            rollup: {
                ...distributedRun.rollup,
                failures: [
                    {
                        kind: 'participant',
                        key: 'agent-a',
                        state: 'failed',
                        error: {
                            code: 'PARTICIPANT_FAILED',
                            message: 'Sender disconnected.'
                        }
                    },
                    {
                        kind: 'participant',
                        key: 'start-b',
                        state: 'failed',
                        error: {
                            code: 'PARTICIPANT_ID_COLLISION',
                            message: 'A participant ID collides with another failure key.'
                        }
                    },
                    {
                        kind: 'recipe',
                        key: 'start-b',
                        state: 'failed',
                        error: {
                            code: 'RECIPE_ID_COLLISION',
                            message: 'A recipe ID collides with another failure key.'
                        }
                    },
                    ...distributedRun.rollup.failures
                ]
            }
        };
        const evidenceControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'event-start-b',
                    atEpochMs: 1_980,
                    payload: {
                        distributedRunId: 'dist-1',
                        topic: 'recipe.failure',
                        message: 'receiver evidence'
                    }
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'start-a',
                    eventId: 'diagnostic-agent-a',
                    atEpochMs: 1_990,
                    payload: {
                        diagnosticSchemaVersion: 1,
                        diagnosticTypeId: 'rallar.test.sender_failure',
                        topic: 'rallar.test.sender_failure',
                        severity: 'error',
                        message: 'Sender disconnected.',
                        commandId: 'start-a'
                    }
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'diagnostic-start-b',
                    atEpochMs: 1_990,
                    payload: {
                        diagnosticSchemaVersion: 1,
                        diagnosticTypeId: 'rallar.test.receiver_failure',
                        topic: 'rallar.test.receiver_failure',
                        severity: 'error',
                        message: 'Receiver did not observe payload.',
                        transport: 'realtime',
                        commandId: 'start-b'
                    }
                }
            ]
        };
        const monitor = deriveDistributedRunMonitor({
            distributedRun: evidenceRun,
            controlRun: evidenceControlRun,
            artifactBundle: distributedArtifactBundle
        });
        const failure = (kind: DistributedRunFailureRow['kind'], key: string) => {
            const row = monitor.failures.find((candidate) => candidate.kind === kind && candidate.key === key);
            expect(row, `${kind}:${key}`).toBeDefined();
            if (!row) {
                throw new Error(`Missing test failure ${kind}:${key}.`);
            }
            return row;
        };
        const destinations = (kind: DistributedRunFailureRow['kind'], key: string) =>
            computeDistributedRunFailureEvidenceDestinations({
                failure: failure(kind, key),
                monitor
            });

        const runDestinations = destinations('run', 'dist-1');
        expect(runDestinations.map((destination) => destination.kind)).not.toEqual(
            expect.arrayContaining(['agent', 'recipe', 'command', 'diagnostic'])
        );
        expect(runDestinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'timeline' }),
            expect.objectContaining({ kind: 'event', id: 'message-a' }),
            expect.objectContaining({ kind: 'artifact', id: 'valid' })
        ]));

        const participantDestinations = destinations('participant', 'agent-a');
        expect(participantDestinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'agent', id: 'agent-a' }),
            expect.objectContaining({ kind: 'recipe', id: 'health-only' }),
            expect.objectContaining({ kind: 'command', id: 'stage-a' }),
            expect.objectContaining({ kind: 'command', id: 'start-a' }),
            expect.objectContaining({ kind: 'diagnostic', id: 'diagnostic-agent-a' }),
            expect.objectContaining({ kind: 'timeline', agentId: 'agent-a' }),
            expect.objectContaining({ kind: 'event', id: 'message-a' }),
            expect.objectContaining({ kind: 'artifact', id: 'valid' })
        ]));
        expect(participantDestinations.some((destination) => destination.id === 'agent-b')).toBe(false);

        const recipeDestinations = destinations('recipe', 'health-only');
        expect(recipeDestinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'agent', id: 'agent-a' }),
            expect.objectContaining({ kind: 'agent', id: 'agent-b' }),
            expect.objectContaining({ kind: 'recipe', id: 'health-only' }),
            expect.objectContaining({ kind: 'command', id: 'stage-a' }),
            expect.objectContaining({ kind: 'command', id: 'stage-b' }),
            expect.objectContaining({ kind: 'command', id: 'start-a' }),
            expect.objectContaining({ kind: 'command', id: 'start-b' }),
            expect.objectContaining({ kind: 'timeline', recipeId: 'health-only' }),
            expect.objectContaining({ kind: 'event', id: 'event-start-b' }),
            expect.objectContaining({ kind: 'artifact', id: 'valid' })
        ]));

        const commandDestinations = destinations('command', 'start-b');
        expect(commandDestinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'agent', id: 'agent-b' }),
            expect.objectContaining({ kind: 'recipe', id: 'health-only' }),
            expect.objectContaining({ kind: 'command', id: 'start-b' }),
            expect.objectContaining({ kind: 'diagnostic', id: 'diagnostic-start-b' }),
            expect.objectContaining({ kind: 'timeline', commandId: 'start-b' }),
            expect.objectContaining({ kind: 'event', id: 'event-start-b' }),
            expect.objectContaining({ kind: 'artifact', id: 'valid' })
        ]));
        const collidingParticipantDestinations = destinations('participant', 'start-b');
        expect(collidingParticipantDestinations.some((destination) => destination.kind === 'diagnostic' && destination.id === 'diagnostic-start-b')).toBe(
            false
        );
        const collidingRecipeDestinations = destinations('recipe', 'start-b');
        expect(collidingRecipeDestinations.some((destination) => destination.kind === 'diagnostic' && destination.id === 'diagnostic-start-b')).toBe(false);
        const receiverDiagnostic = monitor.runtimeDiagnostics.find((diagnostic) => diagnostic.eventId === 'diagnostic-start-b');
        expect(receiverDiagnostic).toBeDefined();
        if (!receiverDiagnostic) {
            throw new Error('Missing receiver diagnostic.');
        }
        const monitorWithDimensionalDiagnostics = {
            ...monitor,
            runtimeDiagnostics: [
                ...monitor.runtimeDiagnostics,
                {
                    ...receiverDiagnostic,
                    eventId: 'diagnostic-health-only',
                    agentId: 'agent-a',
                    commandId: 'start-a',
                    correlatedFailureKeys: ['health-only']
                },
                {
                    ...receiverDiagnostic,
                    eventId: 'diagnostic-start-b-wrong-agent',
                    agentId: 'agent-a',
                    correlatedFailureKeys: ['start-b']
                }
            ]
        };
        expect(computeDistributedRunFailureEvidenceDestinations({
            failure: failure('recipe', 'health-only'),
            monitor: monitorWithDimensionalDiagnostics
        })).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'diagnostic', id: 'diagnostic-health-only' })
        ]));
        expect(
            computeDistributedRunFailureEvidenceDestinations({
                failure: failure('command', 'start-b'),
                monitor: monitorWithDimensionalDiagnostics
            }).some((destination) =>
                destination.kind === 'diagnostic' &&
                destination.id === 'diagnostic-start-b-wrong-agent'
            )
        ).toBe(false);

        const monitorWithoutArtifact = deriveDistributedRunMonitor({
            distributedRun: evidenceRun,
            controlRun: evidenceControlRun
        });
        expect(
            computeDistributedRunFailureEvidenceDestinations({
                failure: failure('command', 'start-b'),
                monitor: monitorWithoutArtifact
            }).some((destination) => destination.kind === 'artifact')
        ).toBe(false);
        const monitorWithInvalidArtifact = deriveDistributedRunMonitor({
            distributedRun: evidenceRun,
            controlRun: evidenceControlRun,
            artifactBundle: {
                ...distributedArtifactBundle,
                files: {
                    ...distributedArtifactBundle.files,
                    'control-run.json': '{invalid'
                }
            }
        });
        expect(
            computeDistributedRunFailureEvidenceDestinations({
                failure: failure('command', 'start-b'),
                monitor: monitorWithInvalidArtifact
            }).some((destination) => destination.kind === 'artifact')
        ).toBe(false);
    });

    it('derives a human-readable analysis report with first failure and truncation warnings', () => {
        const report = deriveDistributedRunAnalysisReport({
            distributedRun,
            controlRun: distributedControlRun,
            artifactBundle: distributedArtifactBundle,
            snapshotBounds: {
                commands: 4,
                results: 4,
                events: 1
            }
        });

        expect(report.summary).toMatchObject({
            state: 'failed',
            ok: false,
            durationMs: 700,
            targetCount: 2,
            commandCount: 4,
            failedCommandCount: 1,
            artifactStatus: 'valid',
            snapshotMayBeTruncated: true
        });
        expect(report.firstFailure).toMatchObject({
            category: 'command',
            commandId: 'start-b',
            agentId: 'agent-b',
            code: 'ASSERTION_FAILED'
        });
        expect(report.agents.find((row) => row.agentId === 'agent-b')).toMatchObject({
            execution: 'failed',
            failedCommandCount: 1,
            reconnectCount: 0
        });
        expect(report.recipes[0]).toMatchObject({
            recipeId: 'health-only',
            failedCount: 1
        });
        expect(report.nextActions[0]).toMatchObject({
            category: 'command',
            title: 'Distributed command failed'
        });
        expect(report.rawEvidence.failureKeys).toContain('start-b');
        expect(report.summary.snapshotWarnings.join(' ')).toContain('commands');
    });

    it('maps common distributed failure modes to actionable explanations', () => {
        const cases = [
            {
                code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
                message: 'No target control agents were resolved for this distributed run.',
                category: 'targeting',
                nextAction: 'Open or restart agents'
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH',
                message: 'Resolved 1 target agents, expected 2.',
                category: 'targeting',
                nextAction: 'expected participant count'
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
                message: 'Agent agent-a did not ACK distributed-run staging before ackTimeoutMs.',
                category: 'readiness',
                nextAction: 'agent tab is still connected'
            },
            {
                code: 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT',
                message: 'Agent agent-a did not report barrier.ready before barrier timeout.',
                category: 'barrier',
                nextAction: 'ACK readiness'
            }
        ] as const;

        cases.forEach((testCase) => {
            const report = deriveDistributedRunAnalysisReport({
                distributedRun: {
                    ...distributedRun,
                    state: testCase.code.includes('TIMEOUT') ? 'timed-out' : 'failed',
                    error: testCase.code.includes('TARGET')
                        ? {
                            code: testCase.code,
                            message: testCase.message
                        }
                        : undefined,
                    rollup: {
                        ...distributedRun.rollup,
                        state: testCase.code.includes('TIMEOUT') ? 'timed-out' : 'failed',
                        ok: false,
                        failures: testCase.code.includes('TARGET')
                            ? []
                            : [{
                                kind: 'participant',
                                key: 'agent-a',
                                state: 'timed-out',
                                error: {
                                    code: testCase.code,
                                    message: testCase.message
                                }
                            }]
                    }
                }
            });

            expect(report.nextActions[0]).toMatchObject({
                category: testCase.category
            });
            expect(report.nextActions[0].nextAction).toContain(testCase.nextAction);
        });
    });

    it('derives composite drilldowns and child failure focus for distributed recipe runs', async () => {
        const compositeRecipe = {
            schemaVersion: 1,
            recipeId: 'composite-evidence',
            commands: [{
                kind: 'parallel',
                commandId: 'root-parallel',
                maxConcurrency: 1,
                groups: [
                    {
                        groupId: 'left',
                        commands: [{
                            kind: 'loop',
                            commandId: 'frame-loop',
                            count: 2,
                            commands: [{
                                kind: 'rtc.send',
                                commandId: 'position-send',
                                send: {
                                    frame: '{loop.iteration}'
                                }
                            }]
                        }]
                    },
                    {
                        groupId: 'right',
                        commands: [
                            {
                                kind: 'wait',
                                commandId: 'wait-ready',
                                match: {
                                    topic: 'rallar.test.ready',
                                    payloadPath: 'state',
                                    equals: 'ready'
                                }
                            },
                            {
                                kind: 'assert',
                                commandId: 'assert-event-count',
                                source: 'events.length',
                                operator: 'gte',
                                expected: 99
                            }
                        ]
                    }
                ]
            }]
        } satisfies DistributedRecipeCatalogItem['recipe'];
        let now = 3_000;
        const runtime = createRallarBlackBoxTestRuntime({
            now: () => {
                now += 10;
                return now;
            }
        });
        runtime.recordEvent({
            kind: 'message',
            topic: 'rallar.test.ready',
            payload: {
                state: 'ready'
            }
        });
        const compositeResult = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'start-b',
            recipe: compositeRecipe
        });
        const compositeRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            manifest: {
                ...distributedRun.manifest,
                recipes: [{
                    recipeId: 'composite-evidence',
                    recipe: compositeRecipe,
                    profile: 'composite',
                    required: true,
                    variables: {}
                }]
            },
            commandLinks: distributedRun.commandLinks.map((link) => ({
                ...link,
                recipeId: 'composite-evidence'
            })),
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'recipe',
                    key: 'composite-evidence',
                    state: 'failed',
                    error: {
                        code: 'RECIPE_FAILED',
                        message: 'Composite recipe failed.'
                    }
                }]
            }
        };
        const controlRunWithComposite: ControlRunSnapshot = {
            ...distributedControlRun,
            results: distributedControlRun.results.map((result) =>
                result.commandId === 'start-b'
                    ? {
                        ...result,
                        ok: false,
                        error: compositeResult.error,
                        result: compositeResult
                    }
                    : result
            ),
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'composite-event',
                    atEpochMs: 3_090,
                    payload: {
                        distributedRunId: 'dist-1',
                        topic: 'composite.failure',
                        message: 'Composite child failed.'
                    }
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'composite-diagnostic',
                    atEpochMs: 3_100,
                    payload: {
                        diagnosticSchemaVersion: 1,
                        diagnosticTypeId: 'rallar.test.composite_failure',
                        topic: 'rallar.test.composite_failure',
                        severity: 'error',
                        message: 'Composite child failed.',
                        commandId: 'start-b'
                    }
                }
            ]
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun: compositeRun,
            controlRun: controlRunWithComposite
        });
        const drilldown = monitor.compositeDrilldowns[0];

        expect(monitor.compositeCounts).toMatchObject({
            total: 1,
            failed: 1,
            childResults: 6,
            composite: 2,
            leaf: 4
        });
        expect(drilldown).toMatchObject({
            agentId: 'agent-b',
            recipeId: 'composite-evidence',
            commandId: 'start-b',
            artifactRef: 'control-run.json#results[commandId=start-b]',
            summary: {
                total: 6,
                failed: 2,
                composite: 2,
                leaf: 4
            }
        });
        expect(drilldown.rows.map((row) => row.kind)).toEqual(expect.arrayContaining([
            'parallel',
            'loop',
            'rtc.send',
            'wait',
            'assert'
        ]));
        expect(drilldown.firstFailure).toMatchObject({
            kind: 'assert',
            originalCommandId: 'assert-event-count',
            status: 'failed'
        });
        expect(drilldown.firstFailure?.summary).toContain('expected 99');
        expect(drilldown.firstFailure?.errorSummary).toContain('RALLAR_BLACK_BOX_ASSERT_FAILED');
        expect(drilldown.rows.find((row) => row.kind === 'wait')?.summary).toContain('matched');
        expect(drilldown.groupSummaries).toEqual(expect.arrayContaining([
            expect.objectContaining({ groupId: 'left', status: 'passed' }),
            expect.objectContaining({ groupId: 'right', status: 'failed' })
        ]));
        expect(monitor.failures).toEqual(expect.arrayContaining([
            expect.objectContaining({
                commandId: drilldown.firstFailure?.commandId,
                agentId: 'agent-b',
                recipeId: 'composite-evidence',
                message: expect.stringContaining('RALLAR_BLACK_BOX_ASSERT_FAILED')
            })
        ]));
        const compositeFailure = monitor.failures.find((failure) =>
            failure.commandId === drilldown.firstFailure?.commandId &&
            failure.key !== 'start-b'
        );
        expect(compositeFailure).toBeDefined();
        if (!compositeFailure) {
            throw new Error('Missing composite child failure.');
        }
        const evidenceDestinations = computeDistributedRunFailureEvidenceDestinations({
            failure: compositeFailure,
            monitor
        });
        expect(evidenceDestinations).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'agent', id: 'agent-b' }),
            expect.objectContaining({ kind: 'recipe', id: 'composite-evidence' }),
            expect.objectContaining({ kind: 'command', id: drilldown.firstFailure?.commandId }),
            expect.objectContaining({ kind: 'command', id: 'start-b' }),
            expect.objectContaining({ kind: 'diagnostic', id: 'composite-diagnostic' }),
            expect.objectContaining({ kind: 'timeline', commandId: 'start-b' }),
            expect.objectContaining({ kind: 'event', id: 'composite-event' })
        ]));
        expect(evidenceDestinations.some((destination) => destination.kind === 'artifact')).toBe(false);
    });

    it('builds a live-warning regression report from visible monitor and artifact evidence', () => {
        const liveMessageId = 'live-message-visible-in-monitor';
        const controlRunWithLiveWarning: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    eventId: 'live-message-event',
                    atEpochMs: 2_050,
                    payload: {
                        kind: 'message',
                        topic: 'room.live.warning.regression',
                        payload: {
                            data: {
                                distributedRunId: 'dist-1',
                                messageId: liveMessageId
                            }
                        }
                    }
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    eventId: 'live-warning-diagnostic',
                    atEpochMs: 2_060,
                    payload: {
                        kind: 'diagnostic',
                        topic: 'rallar.browser.ws.unhandled_message',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                            topic: 'rallar.browser.ws.unhandled_message',
                            severity: 'warning',
                            message: 'Unhandled WS message',
                            transport: 'ws',
                            groupId: 'bb-group',
                            data: {
                                distributedRunId: 'dist-1',
                                messageId: liveMessageId
                            }
                        }
                    }
                }
            ]
        };
        const artifactBundle: ControlDistributedRunArtifactBundle = {
            ...distributedArtifactBundle,
            files: {
                ...distributedArtifactBundle.files,
                'control-run.json': JSON.stringify(controlRunWithLiveWarning)
            }
        };

        const report = deriveDistributedRunWarningRegressionReport({
            distributedRun,
            controlRun: controlRunWithLiveWarning,
            artifactBundle,
            expectation: {
                messageEvidence: [liveMessageId],
                diagnosticTypeIds: ['rallar.browser.ws.unhandled_message'],
                failOnDiagnosticSeverities: ['error']
            }
        });

        expect(report.ok, report.failures.join('\n')).toBe(true);
        expect(report.observed.monitorMessageEvidence).toEqual([liveMessageId]);
        expect(report.observed.artifactMessageEvidence).toEqual([liveMessageId]);
        expect(report.observed.warningDiagnosticTypeIds).toEqual(['rallar.browser.ws.unhandled_message']);
        expect(report.observed.highSeverityDiagnosticTypeIds).toEqual([]);

        const errorReport = deriveDistributedRunWarningRegressionReport({
            distributedRun,
            controlRun: {
                ...controlRunWithLiveWarning,
                events: [
                    ...controlRunWithLiveWarning.events,
                    {
                        kind: 'diagnostic',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-b',
                        eventId: 'live-error-diagnostic',
                        atEpochMs: 2_070,
                        payload: {
                            kind: 'diagnostic',
                            topic: 'rallar.browser.realtime.send_failed',
                            severity: 'error',
                            payload: {
                                diagnosticSchemaVersion: 1,
                                diagnosticTypeId: 'rallar.browser.realtime.send_failed',
                                topic: 'rallar.browser.realtime.send_failed',
                                severity: 'error',
                                message: 'Realtime send failed.',
                                transport: 'realtime',
                                data: {
                                    distributedRunId: 'dist-1'
                                }
                            }
                        }
                    }
                ]
            },
            expectation: {
                diagnosticTypeIds: ['rallar.browser.ws.unhandled_message'],
                failOnDiagnosticSeverities: ['error']
            }
        });

        expect(errorReport.ok).toBe(false);
        expect(errorReport.failures).toContain(
            'High-severity runtime diagnostic observed: rallar.browser.realtime.send_failed'
        );
    });

    it('shows distributed barrier commands as monitor evidence', () => {
        const barrierRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            state: 'waiting-for-barrier',
            barrierStartedAtEpochMs: 1_300,
            barrierCompletedAtEpochMs: 1_420,
            manifest: {
                ...distributedRun.manifest,
                barrier: {
                    enabled: true,
                    timeoutMs: 5_000
                }
            },
            commandLinks: [
                ...distributedRun.commandLinks,
                { phase: 'barrier', agentId: 'agent-a', commandId: 'barrier-a', queuedAtEpochMs: 1_300 },
                { phase: 'barrier', agentId: 'agent-b', commandId: 'barrier-b', queuedAtEpochMs: 1_305 }
            ]
        };
        const barrierControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            commands: [
                ...distributedControlRun.commands,
                {
                    envelope: {
                        kind: 'command',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-a',
                        commandId: 'barrier-a',
                        command: { kind: 'health', commandId: 'barrier-a' }
                    },
                    queuedAtEpochMs: 1_300,
                    dispatchedAtEpochMs: 1_310,
                    completedAtEpochMs: 1_400,
                    dispatchCount: 1
                },
                {
                    envelope: {
                        kind: 'command',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-b',
                        commandId: 'barrier-b',
                        command: { kind: 'health', commandId: 'barrier-b' }
                    },
                    queuedAtEpochMs: 1_305,
                    dispatchedAtEpochMs: 1_315,
                    completedAtEpochMs: 1_420,
                    dispatchCount: 1
                }
            ],
            results: [
                ...distributedControlRun.results,
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'barrier-a',
                    ok: true,
                    result: {
                        commandId: 'barrier-a',
                        kind: 'health',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1_310,
                        endedAtEpochMs: 1_400,
                        durationMs: 90
                    }
                },
                {
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'barrier-b',
                    ok: true,
                    result: {
                        commandId: 'barrier-b',
                        kind: 'health',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1_315,
                        endedAtEpochMs: 1_420,
                        durationMs: 105
                    }
                }
            ]
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun: barrierRun,
            controlRun: barrierControlRun
        });

        expect(monitor.commandCounts.barrier).toBe(2);
        expect(monitor.agentProgress.map((row) => [row.agentId, row.barrier])).toEqual([
            ['agent-a', 'ready'],
            ['agent-b', 'ready']
        ]);
        expect(monitor.timeline.map((item) => item.label)).toEqual(expect.arrayContaining([
            'barrier started',
            'barrier ready',
            'barrier queued',
            'barrier completed'
        ]));
    });
});

describe('distributed run monitor strict diagnostic decoding', () => {
    const linkedDiagnosticMonitor = (
        payload: ControlRunSnapshot['events'][number]['payload']
    ): ReturnType<typeof deriveDistributedRunMonitor> =>
        deriveDistributedRunMonitor({
            distributedRun,
            controlRun: {
                ...distributedControlRun,
                events: [
                    ...distributedControlRun.events,
                    {
                        kind: 'diagnostic',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-a',
                        commandId: 'start-a',
                        eventId: 'strict-decoding-candidate',
                        atEpochMs: 1_900,
                        payload
                    }
                ]
            }
        });

    it('decodes canonical version-1 diagnostics in both the nested and the direct envelope placement', () => {
        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: {
                ...distributedControlRun,
                events: [
                    ...distributedControlRun.events,
                    {
                        kind: 'diagnostic',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-a',
                        commandId: 'start-a',
                        eventId: 'diagnostic-direct',
                        atEpochMs: 1_900,
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
                            topic: 'rallar.browser.rtc.data_channel_mismatch',
                            severity: 'warning',
                            transport: 'realtime',
                            message: 'Direct placement diagnostic.',
                            laneId: 'rtc-realtime'
                        }
                    },
                    {
                        kind: 'diagnostic',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: 'agent-b',
                        commandId: 'start-b',
                        eventId: 'diagnostic-nested',
                        atEpochMs: 1_950,
                        payload: {
                            topic: 'rallar.browser.ws.unhandled_message',
                            payload: {
                                diagnosticSchemaVersion: 1,
                                diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                                topic: 'rallar.browser.ws.unhandled_message',
                                severity: 'warning',
                                transport: 'ws',
                                message: 'Nested placement diagnostic.',
                                laneId: 'ws-lane'
                            }
                        }
                    }
                ]
            }
        });

        expect(monitor.runtimeDiagnostics.map((row) => [row.eventId, row.transport, row.laneId])).toEqual([
            ['diagnostic-direct', 'realtime', 'rtc-realtime'],
            ['diagnostic-nested', 'ws', 'ws-lane']
        ]);
    });

    it('ignores a linked diagnostic that names a diagnostic type without the canonical schema version', () => {
        const monitor = linkedDiagnosticMonitor({
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
            topic: 'rallar.browser.rtc.data_channel_mismatch',
            severity: 'warning',
            transport: 'realtime',
            message: 'Unversioned diagnostic payload.'
        });

        expect(monitor.runtimeDiagnostics).toEqual([]);
        expect(monitor.diagnosticCounts.total).toBe(0);
    });

    it('ignores a linked event whose only diagnostic evidence is transport or message text', () => {
        const monitor = linkedDiagnosticMonitor({
            topic: 'recipe.progress',
            transport: 'ws',
            message: 'Unhandled ws data-channel text without a diagnostic contract.'
        });

        expect(monitor.runtimeDiagnostics).toEqual([]);
        expect(monitor.diagnosticCounts.total).toBe(0);
    });

    it('projects no expected lane, observed lane, or accepted row field', () => {
        const monitor = linkedDiagnosticMonitor({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
            topic: 'rallar.browser.rtc.data_channel_mismatch',
            severity: 'warning',
            transport: 'realtime',
            message: 'Received data channel for different data channel name.',
            laneId: 'rtc-realtime',
            expectedChannelLabel: 'rtc-realtime',
            observedChannelLabel: 'rtc-data-channel',
            accepted: false
        });
        const [row] = monitor.runtimeDiagnostics;

        expect(row?.laneId).toBe('rtc-realtime');
        const rowKeys = Object.keys(row ?? {});
        expect(rowKeys).not.toContain('expectedLaneId');
        expect(rowKeys).not.toContain('observedLaneId');
        expect(rowKeys).not.toContain('accepted');
        // The removed summary segment rendered as "lane <expected> -> <observed>".
        expect(row?.summary).not.toMatch(/lane \S+ -> /);
    });
});
