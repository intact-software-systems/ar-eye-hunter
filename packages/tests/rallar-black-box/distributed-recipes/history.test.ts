import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    compareDistributedRuns,
    deriveDistributedRunMonitor,
    filterDistributedRuns
} from '../../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { distributedControlRun, distributedRun } from './distributed-run-fixture.ts';

describe('distributed recipes history', () => {
    it('extracts WS and RTC runtime diagnostics for distributed run monitor filtering and failure correlation', () => {
        const controlRunWithDiagnostics: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-b',
                    commandId: 'start-b',
                    eventId: 'diag-ws-unhandled',
                    atEpochMs: 1_985,
                    payload: {
                        eventId: 'runtime-diag-ws',
                        kind: 'diagnostic',
                        topic: 'rallar.browser.ws.unhandled_message',
                        atEpochMs: 1_985,
                        commandId: 'start-b',
                        transport: 'ws',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                            topic: 'rallar.browser.ws.unhandled_message',
                            severity: 'warning',
                            message: 'Unhandled WS message',
                            transport: 'ws',
                            groupId: 'bb-group',
                            senderId: 'agent-a',
                            typeId: 'rallar.message',
                            topicId: 'room.payload',
                            contextId: 'bb-group',
                            resourceId: 'payload-1',
                            data: {
                                typeId: 'rallar.message',
                                topicId: 'room.payload'
                            },
                            source: 'browser-rallar-runtime'
                        }
                    }
                },
                {
                    kind: 'diagnostic',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-a',
                    commandId: 'start-a',
                    eventId: 'diag-rtc-lane',
                    atEpochMs: 1_720,
                    payload: {
                        eventId: 'runtime-diag-rtc',
                        kind: 'diagnostic',
                        topic: 'rallar.browser.rtc.data_channel_mismatch',
                        atEpochMs: 1_720,
                        commandId: 'start-a',
                        transport: 'realtime',
                        severity: 'warning',
                        payload: {
                            diagnosticSchemaVersion: 1,
                            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
                            topic: 'rallar.browser.rtc.data_channel_mismatch',
                            severity: 'warning',
                            message: 'Received data channel for different data channel name.',
                            transport: 'realtime',
                            groupId: 'bb-group',
                            peerId: 'agent-b',
                            laneId: 'rtc-data-channel',
                            source: 'browser-rallar-runtime'
                        }
                    }
                }
            ]
        };

        const monitor = deriveDistributedRunMonitor({
            distributedRun,
            controlRun: controlRunWithDiagnostics
        });

        expect(monitor.diagnosticCounts).toMatchObject({
            total: 2,
            warning: 2,
            ws: 1,
            rtc: 1
        });
        expect(monitor.runtimeDiagnostics.map((row) => [row.eventId, row.transport, row.groupId])).toEqual([
            ['diag-rtc-lane', 'realtime', 'bb-group'],
            ['diag-ws-unhandled', 'ws', 'bb-group']
        ]);
        expect(monitor.runtimeDiagnostics[0]).toMatchObject({
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_mismatch',
            laneId: 'rtc-data-channel',
            peerId: 'agent-b'
        });
        expect(monitor.runtimeDiagnostics[1]).toMatchObject({
            message: 'Unhandled WS message',
            typeId: 'rallar.message',
            topicId: 'room.payload',
            correlatedFailureKeys: expect.arrayContaining(['start-b'])
        });
        expect(monitor.timeline.map((item) => item.kind)).toContain('diagnostic');
        expect(monitor.timeline.map((item) => item.label)).toEqual(expect.arrayContaining([
            'realtime warning',
            'ws warning'
        ]));
    });

    it('filters distributed run history by group, recipe, user, status, date, and failure type', () => {
        const otherRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-2',
            state: 'passed',
            createdAtEpochMs: 5_000,
            updatedAtEpochMs: 5_500,
            manifest: {
                ...distributedRun.manifest,
                distributedRunId: 'dist-2',
                group: {
                    ...distributedRun.manifest.group,
                    groupId: 'other-group'
                },
                recipes: [{ recipeId: 'other-recipe', profile: 'regression', variables: {}, required: true }],
                metadata: {
                    createdBy: 'bob'
                }
            },
            rollup: {
                ...distributedRun.rollup,
                state: 'passed',
                ok: true,
                failures: [],
                summary: {
                    ...distributedRun.rollup.summary,
                    blockingFailures: 0,
                    failedRecipes: 0
                }
            }
        };

        expect(
            filterDistributedRuns([otherRun, distributedRun], {
                groupId: 'bb-group',
                recipeId: 'health',
                profile: 'smoke',
                user: 'alice',
                status: 'failed',
                failureType: 'recipe',
                fromEpochMs: 900,
                toEpochMs: 1_100
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-1']);

        expect(
            filterDistributedRuns([otherRun, distributedRun], {
                query: 'regression'
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-2']);
    });

    it('filters actual run and rollup failures by their semantic explanation category', () => {
        const targetingRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-targeting',
            updatedAtEpochMs: 4_000,
            error: {
                code: 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS',
                message: 'No target agents resolved.'
            },
            rollup: {
                ...distributedRun.rollup,
                failures: []
            }
        };
        const barrierRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-barrier',
            updatedAtEpochMs: 3_000,
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'participant',
                    key: 'agent-a',
                    state: 'failed',
                    error: {
                        code: 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT',
                        message: 'Barrier timed out.'
                    }
                }]
            }
        };
        const readinessRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-readiness',
            updatedAtEpochMs: 2_500,
            rollup: {
                ...distributedRun.rollup,
                failures: [{
                    kind: 'participant',
                    key: 'agent-b',
                    state: 'failed',
                    error: {
                        code: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
                        message: 'Agent ACK timeout.'
                    }
                }]
            }
        };
        const rtcStreamRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-rtc-stream',
            updatedAtEpochMs: 2_750,
            error: {
                code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                message: 'RTC stream pacing exceeded maxDroppedFrames.'
            },
            rollup: {
                ...distributedRun.rollup,
                failures: []
            }
        };
        const multipleCategoryRun: ControlDistributedRunSnapshot = {
            ...targetingRun,
            distributedRunId: 'dist-multiple-categories',
            updatedAtEpochMs: 4_500,
            rollup: barrierRun.rollup
        };

        const runs = [
            readinessRun,
            distributedRun,
            targetingRun,
            barrierRun,
            rtcStreamRun,
            multipleCategoryRun
        ];
        expect(
            filterDistributedRuns(runs, {
                failureCategory: ' TARGETING '
            }).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-multiple-categories',
            'dist-targeting'
        ]);
        expect(
            filterDistributedRuns(runs, {
                failureCategory: 'barrier'
            }).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-multiple-categories',
            'dist-barrier'
        ]);
        expect(
            filterDistributedRuns(runs, {
                failureCategory: 'readiness'
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-readiness']);
        expect(
            filterDistributedRuns(runs, {
                failureCategory: 'rtc-stream-performance'
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-rtc-stream']);
        expect(
            filterDistributedRuns(runs, {
                failureCategory: 'unknown'
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-1']);
        expect(
            filterDistributedRuns(runs, {
                failureCategory: 'any'
            }).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-multiple-categories',
            'dist-targeting',
            'dist-barrier',
            'dist-rtc-stream',
            'dist-readiness',
            'dist-1'
        ]);
    });

    it('preserves raw failure text matching, inclusive dates, combined filters, and empty results', () => {
        expect(
            filterDistributedRuns([distributedRun], {
                query: 'RECEIVER DID NOT OBSERVE',
                groupId: 'BB-GROUP',
                recipeId: 'HEALTH',
                profile: 'SMOKE',
                user: 'ALICE',
                status: 'FAILED',
                failureType: ' RECIPE_FAILED ',
                failureCategory: 'UNKNOWN',
                fromEpochMs: distributedRun.createdAtEpochMs,
                toEpochMs: distributedRun.createdAtEpochMs
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-1']);

        expect(
            filterDistributedRuns([distributedRun], {
                failureType: 'any'
            }).map((run) => run.distributedRunId)
        ).toEqual(['dist-1']);
        expect(filterDistributedRuns([distributedRun], {
            fromEpochMs: distributedRun.createdAtEpochMs + 1
        })).toEqual([]);
        expect(filterDistributedRuns([distributedRun], {
            toEpochMs: distributedRun.createdAtEpochMs - 1
        })).toEqual([]);
        expect(filterDistributedRuns([distributedRun], {
            fromEpochMs: distributedRun.createdAtEpochMs + 1,
            toEpochMs: distributedRun.createdAtEpochMs - 1
        })).toEqual([]);
        expect(filterDistributedRuns([distributedRun], {
            failureCategory: 'targeting'
        })).toEqual([]);
    });

    it('keeps descending history order stable when updated timestamps tie', () => {
        const firstTie = {
            ...distributedRun,
            distributedRunId: 'dist-first-tie',
            updatedAtEpochMs: 4_000
        };
        const secondTie = {
            ...distributedRun,
            distributedRunId: 'dist-second-tie',
            updatedAtEpochMs: 4_000
        };
        const newest = {
            ...distributedRun,
            distributedRunId: 'dist-newest',
            updatedAtEpochMs: 5_000
        };

        expect(
            filterDistributedRuns(
                [firstTie, newest, secondTie],
                {}
            ).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-newest',
            'dist-first-tie',
            'dist-second-tie'
        ]);
    });

    it('treats malformed manifest fields as absent without losing top-level history evidence', () => {
        const malformedManifestRun = Object.defineProperty(
            {
                ...distributedRun,
                distributedRunId: 'dist-malformed-manifest'
            },
            'manifest',
            { value: undefined }
        );
        const malformedFieldsRun = Object.defineProperty(
            {
                ...distributedRun,
                distributedRunId: 'dist-malformed-fields'
            },
            'manifest',
            {
                value: {
                    displayName: { text: 'not searchable' },
                    group: {
                        applicationId: { text: 'not searchable' },
                        workspaceId: { text: 'not searchable' },
                        groupId: { text: 'not searchable' }
                    },
                    recipes: { recipeId: 'not-an-array' },
                    metadata: { createdBy: { name: 'not searchable' } }
                }
            }
        );
        const independentSelectionRun = Object.defineProperty(
            {
                ...distributedRun,
                distributedRunId: 'dist-independent-selections'
            },
            'manifest',
            {
                value: {
                    ...distributedRun.manifest,
                    recipes: [
                        null,
                        { profile: 'regression' },
                        { recipeId: 'other-recipe', profile: 'smoke' },
                        {
                            recipeId: 'malformed-profile',
                            profile: { text: 'not searchable' },
                            role: { text: 'not searchable' }
                        }
                    ]
                }
            }
        );

        expect(
            filterDistributedRuns([
                malformedManifestRun,
                malformedFieldsRun
            ], {
                query: 'DIST-MALFORMED-MANIFEST',
                status: 'failed',
                failureType: 'recipe',
                failureCategory: 'unknown'
            }).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-malformed-manifest'
        ]);
        expect(filterDistributedRuns([malformedManifestRun], {
            groupId: 'bb-group'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedManifestRun], {
            recipeId: 'health-only'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedManifestRun], {
            profile: 'smoke'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedManifestRun], {
            user: 'alice'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedFieldsRun], {
            groupId: 'bb-group'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedFieldsRun], {
            recipeId: 'not-an-array'
        })).toEqual([]);
        expect(filterDistributedRuns([
            malformedFieldsRun,
            independentSelectionRun
        ], {
            query: '[object object]'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedFieldsRun], {
            groupId: '[object object]'
        })).toEqual([]);
        expect(filterDistributedRuns([malformedFieldsRun], {
            user: '[object object]'
        })).toEqual([]);
        expect(filterDistributedRuns([independentSelectionRun], {
            profile: '[object object]'
        })).toEqual([]);
        expect(
            filterDistributedRuns([independentSelectionRun], {
                recipeId: 'recipe-2',
                profile: 'smoke'
            }).map((run) => run.distributedRunId)
        ).toEqual([
            'dist-independent-selections'
        ]);
    });

    it('compares distributed runs by recipe, participants, failures, timing, and received messages', () => {
        const rightRun: ControlDistributedRunSnapshot = {
            ...distributedRun,
            distributedRunId: 'dist-2',
            createdAtEpochMs: 2_000,
            startedAtEpochMs: 2_500,
            completedAtEpochMs: 3_800,
            updatedAtEpochMs: 3_800,
            targetAgentIds: ['agent-a', 'agent-c'],
            manifest: {
                ...distributedRun.manifest,
                distributedRunId: 'dist-2',
                recipes: [{
                    ...distributedRun.manifest.recipes[0],
                    profile: 'regression'
                }]
            }
        };
        const rightControlRun: ControlRunSnapshot = {
            ...distributedControlRun,
            events: [
                ...distributedControlRun.events,
                {
                    kind: 'event',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'agent-c',
                    commandId: 'start-c',
                    eventId: 'message-c',
                    atEpochMs: 3_000,
                    payload: {
                        distributedRunId: 'dist-2',
                        topic: 'message.received',
                        message: 'payload received by c'
                    }
                }
            ]
        };

        const comparison = compareDistributedRuns({
            left: distributedRun,
            right: rightRun,
            leftControlRun: distributedControlRun,
            rightControlRun
        });

        expect(comparison.recipeDelta.changedProfiles).toEqual(['health-only: smoke -> regression']);
        expect(comparison.participantDelta.leftOnly).toEqual(['agent-b']);
        expect(comparison.participantDelta.rightOnly).toEqual(['agent-c']);
        expect(comparison.failureDelta.leftCount).toBe(1);
        expect(comparison.timingDelta.durationDeltaMs).toBe(600);
        expect(comparison.receivedMessageDelta.delta).toBe(1);
    });
});
