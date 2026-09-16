import { describe, expect, it } from 'vitest';

import {
    analyzeDistributedRunArtifactFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles
} from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe } from '../../../shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import type { RallarBlackBoxTestCommand } from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    createControlRunSnapshot,
    createDistributedRunManifest,
    createDistributedRunSnapshot,
    toDistributedRunArtifactFiles
} from './distributed-artifact-files-fixture.ts';

function analyzedRun(files: DistributedRunArtifactFiles): DistributedRunAnalysis {
    const analyzed = analyzeDistributedRunArtifactFiles({ files, generatedAtEpochMs: 123 });
    if (analyzed.right?.variant !== 'distributed-run') {
        throw new Error(`Expected a distributed run analysis, got ${JSON.stringify(analyzed.left ?? analyzed.right)}`);
    }
    return analyzed.right.analysis;
}

describe('distributed run artifact receiver delivery', () => {
    it('derives receiver delivery performance from final receiver stats and ignores interim snapshots', () => {
        const receiverInterimStatsCommand: RallarBlackBoxTestCommand = {
            kind: 'stats',
            commandId: 'rtc-messages-principal-receiver-stats',
            metadata: {
                receiverDelivery: {
                    expectedInboundMessages: 600,
                    minExpectedInboundMessages: 570,
                    minReceiveRatio: 0.95
                }
            }
        };
        const receiverStatsCommand: RallarBlackBoxTestCommand = {
            kind: 'stats',
            commandId: 'rtc-messages-principal-receiver-final-stats',
            metadata: {
                receiverDelivery: {
                    expectedInboundMessages: 600,
                    minExpectedInboundMessages: 570,
                    minReceiveRatio: 0.95
                }
            }
        };
        const agentIds = ['controller-02', 'controller-03', 'controller-04'];
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-receiver-delivery',
                controlRunId: 'run-receiver-delivery',
                state: 'passed',
                agentIds,
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 34_000,
                manifest: createDistributedRunManifest({
                    distributedRunId: 'dist-receiver-delivery',
                    controlRunId: 'run-receiver-delivery',
                    agentIds,
                    recipes: [{
                        recipeId: 'rtc-messages-principal-multicast-receiver',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'rtc-messages-principal-multicast-receiver',
                            commands: [receiverInterimStatsCommand, receiverStatsCommand]
                        },
                        role: 'receiver',
                        required: true
                    }]
                })
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-receiver-delivery',
                agents: [
                    { agentId: 'controller-02', receivedEventCount: 610 },
                    { agentId: 'controller-03', receivedEventCount: 570 },
                    { agentId: 'controller-04', receivedEventCount: 625 }
                ]
            }),
            files: {
                'results.jsonl': [
                    JSON.stringify({
                        agentId: 'controller-02',
                        commandId: 'receiver-interim-a',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-stats',
                            counters: { messages: 10 }
                        }
                    }),
                    JSON.stringify({
                        agentId: 'controller-02',
                        commandId: 'receiver-stats-a',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-final-stats',
                            counters: { messages: 580 }
                        }
                    }),
                    JSON.stringify({
                        agentId: 'controller-03',
                        commandId: 'receiver-interim-b',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-stats',
                            counters: { messages: 20 }
                        }
                    }),
                    JSON.stringify({
                        agentId: 'controller-03',
                        commandId: 'receiver-stats-b',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-final-stats',
                            counters: { messages: 560 }
                        }
                    }),
                    JSON.stringify({
                        agentId: 'controller-04',
                        commandId: 'receiver-interim-c',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-stats',
                            counters: { messages: 30 }
                        }
                    }),
                    JSON.stringify({
                        agentId: 'controller-04',
                        commandId: 'receiver-stats-c',
                        action: 'stats',
                        ok: true,
                        result: {
                            commandId: 'rtc-messages-principal-receiver-final-stats',
                            counters: { messages: 600 }
                        }
                    })
                ].join('\n'),
                'events.jsonl': ''
            }
        }));

        expect(analysis.performance?.receiverDelivery).toMatchObject({
            sampleCount: 3,
            expectedInboundMessages: 600,
            minExpectedInboundMessages: 570,
            minReceiveRatio: 0.95,
            minReceivedMessages: 560,
            medianReceivedMessages: 580,
            p95ReceivedMessages: 600,
            maxReceivedMessages: 600,
            minDeliveryRatio: 0.93,
            medianDeliveryRatio: 0.97,
            p95DeliveryRatio: 1
        });
        expect(analysis.performance?.receiverDelivery?.lowestAgents).toEqual([
            {
                agentId: 'controller-03',
                receivedMessages: 560,
                expectedInboundMessages: 600,
                deliveryRatio: 0.93
            },
            {
                agentId: 'controller-02',
                receivedMessages: 580,
                expectedInboundMessages: 600,
                deliveryRatio: 0.97
            },
            {
                agentId: 'controller-04',
                receivedMessages: 600,
                expectedInboundMessages: 600,
                deliveryRatio: 1
            }
        ]);
        expect(analysis.performanceMarkdown).toContain(
            'Receiver delivery: receivers=3, expected=600, min required=570'
        );
        expect(analysis.performanceMarkdown).toContain('lowest=controller-03 560/600 (93%)');
    });

    it('does not derive receiver delivery from all-peer settle stats before streaming starts', () => {
        const recipe = createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9
        });
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-all-peer-settle-only',
                controlRunId: 'run-all-peer-settle-only',
                state: 'cancelled',
                agentIds: ['controller-01'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 8_000,
                manifest: createDistributedRunManifest({
                    distributedRunId: 'dist-all-peer-settle-only',
                    controlRunId: 'run-all-peer-settle-only',
                    agentIds: ['controller-01'],
                    recipes: [{ recipeId: recipe.recipeId, recipe, required: true }]
                })
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-all-peer-settle-only',
                agents: [{ agentId: 'controller-01' }]
            }),
            files: {
                'results.jsonl': JSON.stringify({
                    agentId: 'controller-01',
                    commandId: 'settle-stats-a',
                    action: 'stats',
                    ok: true,
                    result: {
                        commandId: 'rtc-messages-all-peer-settle-stats',
                        counters: { messages: 0 }
                    }
                }),
                'events.jsonl': ''
            }
        }));

        expect(analysis.performance?.receiverDelivery).toBeUndefined();
        expect(analysis.performanceMarkdown).not.toContain('Receiver delivery:');
    });

    it('classifies receiver delivery threshold assertions as delivery failures', () => {
        const analysis = analyzedRun(toDistributedRunArtifactFiles({
            distributedRun: createDistributedRunSnapshot({
                distributedRunId: 'dist-receiver-delivery-failed',
                controlRunId: 'run-receiver-delivery-failed',
                state: 'failed',
                agentIds: ['controller-03'],
                startedAtEpochMs: 1_000,
                completedAtEpochMs: 34_000
            }),
            controlRun: createControlRunSnapshot({
                runId: 'run-receiver-delivery-failed',
                agents: [{ agentId: 'controller-03', receivedEventCount: 570 }]
            }),
            files: {
                'fleet-report.json': JSON.stringify({
                    distributedRunId: 'dist-receiver-delivery-failed',
                    ok: false,
                    summary: {
                        agents: 1,
                        passRate: 0,
                        failureGroups: 1
                    },
                    failureSignatures: [{
                        category: 'command',
                        title: 'Command result failed',
                        normalizedMessage: 'Assert failed for stats.counters.messages.',
                        likelyCause: 'A command assertion failed.',
                        affectedAgents: ['controller-03'],
                        commandId: 'receiver-delivery-threshold'
                    }]
                }),
                'results.jsonl': JSON.stringify({
                    agentId: 'controller-03',
                    commandId: 'receiver-delivery-threshold',
                    action: 'assert',
                    status: 'FAILURE',
                    ok: false,
                    actual: {
                        code: 'RALLAR_BLACK_BOX_ASSERT_FAILED',
                        message: 'Assert failed for stats.counters.messages.',
                        source: 'stats.counters.messages',
                        actual: 560,
                        expected: 570
                    }
                }),
                'events.jsonl': ''
            }
        }));

        expect(analysis.failure).toMatchObject({
            category: 'receiver-delivery',
            title: 'Receiver delivery threshold failed.',
            likelyCause: 'A receiver observed fewer RTC messages than the recipe threshold required.',
            minimalFixArea: 'RTC receiver delivery',
            affectedAgents: ['controller-03'],
            commandId: 'receiver-delivery-threshold',
            evidenceFile: 'results.jsonl'
        });
        expect(analysis.fixProposalMarkdown).toContain('RTC receiver delivery');
    });
});
