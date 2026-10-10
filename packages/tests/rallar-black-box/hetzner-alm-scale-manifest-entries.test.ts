import {
    describe,
    expect,
    it
} from 'vitest';

import { createHetznerDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';
import { toHetznerRecipeCommands } from './hetzner-manifest-test-commands.ts';

describe('Hetzner scale catalog', () => {
    it('publishes frozen match workloads with the shared scale acceptance metadata', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        for (const [agentCount, shotArrivals, meshMinSize] of [[15, 84, '16'], [30, 174, '31'], [50, 294, '51']] as const) {
            const entry = catalog.find((candidate) => candidate.filePath.endsWith(`-alm-conformance-${agentCount}-agent-30s.json`));
            expect(entry).toMatchObject({ agentCount, diagnostic: false, mainline: false });
            expect(entry?.manifest.recipes.map((selection) => [selection.role, selection.recipeId]))
                .toEqual([['sender', 'alm-scale-director'], ['receiver', 'alm-scale-player']]);
            expect(entry?.manifest.targetPolicy).toMatchObject({
                mode: 'role-map',
                expectedParticipantCount: agentCount,
                roles: { sender: ['controller-01'], receiver: expect.any(Array) }
            });
            expect(entry?.manifest.roleAssignments).toHaveLength(agentCount);
            expect(entry?.manifest.roleAssignments.map((assignment) => assignment.agentId))
                .toEqual(Array.from({ length: agentCount }, (_, index) => `controller-${String(index + 1).padStart(2, '0')}`));
            expect(entry?.manifest.roleAssignments.slice(1).every((assignment) => assignment.role === 'receiver')).toBe(true);
            expect(entry?.manifest.metadata).toMatchObject({
                family: 'alm-scale',
                topologyProfile: 'tree',
                transport: 'messages.rtc',
                participantCount: agentCount,
                senderCount: 1,
                receiverCount: agentCount - 1,
                expectedDurationSeconds: 30,
                recommendedTerminalTimeoutSeconds: 330,
                rtcTopologyEnv: { RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: meshMinSize },
                loadEstimate: { logicalFanoutMessages: shotArrivals + 2 * (agentCount - 1) },
                almMetrics: {
                    shotsPerPlayer: 6,
                    lifecycleEvents: 2,
                    sampleCount: 7,
                    intervalMs: 5_000,
                    samplingWindowMs: 30_000,
                    workloadWindowMs: 30_000,
                    receiptPolicy: {
                        durability: 'volatile',
                        reliability: 'at-least-once',
                        ttlMs: 30_000,
                        carrier: 'rtc-with-ws-fallback',
                        shotAck: 'group-leader',
                        matchAck: 'all-logical-recipients'
                    },
                    budgets: {
                        'rallar.alm.own.admissions': 1_000,
                        'rallar.alm.own.bytes': 4_194_304,
                        'rallar.alm.usage.oldestAgeMs': 300_000,
                        'rallar.alm.usage.tracks': 64,
                        'rallar.alm.orderingTracks': 512,
                        'rallar.alm.overloaded': false,
                        'rallar.congestion.dropped': 0
                    },
                    storageBudgets: { 'byOwner.al-admission': 0, workNonProbeCount: 0 },
                    excludedStorage: { metric: 'workProbeCount', kinds: ['work-page', 'work-probe'], recorded: true }
                }
            });
            expect(entry?.manifest.metadata.loadEstimate).not.toHaveProperty('streamFrames');
            expect(entry?.manifest.metadata).not.toHaveProperty('rateHz');
        }
    });
});

describe('ALM scale manifest acceptance', () => {
    it('requires complete per-role sampler, workload, arrival and storage evidence for each frozen participant', () => {
        const entries = createHetznerDistributedManifestCatalog().filter((entry) => /(?:19|20|21)-alm-/.test(entry.filePath));
        expect(entries.map((entry) => entry.agentCount)).toEqual([15, 30, 50]);
        for (const entry of entries) {
            for (const [role, recipeId] of [['sender', 'alm-scale-director'], ['receiver', 'alm-scale-player']] as const) {
                const selection = entry.manifest.recipes.find((recipe) => recipe.role === role);
                const commands = toHetznerRecipeCommands(selection?.recipe?.commands ?? []);
                expect(commands.find((command) => command.commandId === `${recipeId}-connect`)).toMatchObject({
                    readiness: { minReadyPeers: 1, timeoutMs: 45_000, intervalMs: 100 },
                    rallar: { messageTypeIds: ['room.ar-eye-hunter.director.intent.v1', 'room.ar-eye-hunter.director.event.v1'] }
                });
                expect(commands.find((command) => command.commandId === `${recipeId}-window`)).toMatchObject({ kind: 'parallel', timeoutMs: 30_000 });
                expect(commands.find((command) => command.commandId === `${recipeId}-sampler`)).toMatchObject({ kind: 'loop', count: 7, intervalMs: 5_000 });
                const sends = commands.filter((command) => command.kind === 'messages.send');
                expect(sends).toHaveLength(role === 'sender' ? 2 : 6);
                for (const send of sends) {
                    expect(send).toMatchObject({
                        carrier: 'rtc-with-ws-fallback',
                        reliability: 'at-least-once',
                        durability: 'volatile',
                        ttlMs: 30_000,
                        ack: role === 'sender' ? 'all-logical-recipients' : 'group-leader',
                        roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'hetzner-headless-room' },
                        topicId: 'room.ar-eye-hunter.director',
                        payload: { protocol: 'rallar.director.relay.v1', payload: { senderId: '{auth.sessionId}' } }
                    });
                }
                expect(commands.find((command) => command.commandId === `${recipeId}-storage-reset`)).toMatchObject({ reset: true });
                expect(commands.find((command) => command.commandId === `${recipeId}-storage`)).toMatchObject({ reset: false });
                const assertions = entry.manifest.groupAssertions.filter((assertion) => assertion.scope?.role === role);
                expect(assertions.every((assertion) => assertion.aggregate === 'allMatch' && assertion.source.recipeId === recipeId)).toBe(true);
                for (
                    const [commandId, path, operator, expected] of [
                        [`${recipeId}-sampler`, 'iterations', 'equals', 7],
                        [`${recipeId}-sampler`, 'pacing.completedIterations', 'equals', 7],
                        [`${recipeId}-sampler`, 'passed', 'equals', 84],
                        [`${recipeId}-sampler`, 'failed', 'equals', 0],
                        [`${recipeId}-sampler`, 'cancelled', 'equals', false],
                        [`${recipeId}-window`, 'groups.0.durationMs', 'lt', 30_000],
                        [`${recipeId}-final-stats`, 'rallar.alm.own.admissions', 'lte', 1_000],
                        [`${recipeId}-final-stats`, 'rallar.alm.own.bytes', 'lte', 4_194_304],
                        [`${recipeId}-final-stats`, 'rallar.alm.usage.oldestAgeMs', 'lte', 300_000],
                        [`${recipeId}-final-stats`, 'rallar.alm.usage.tracks', 'lte', 64],
                        [`${recipeId}-final-stats`, 'rallar.alm.orderingTracks', 'lte', 512],
                        [`${recipeId}-final-stats`, 'rallar.alm.overloaded', 'equals', false],
                        [`${recipeId}-final-stats`, 'rallar.congestion.dropped', 'equals', 0],
                        [`${recipeId}-storage`, 'byOwner.al-admission', 'equals', 0],
                        [`${recipeId}-storage`, 'workNonProbeCount', 'equals', 0],
                        [`${recipeId}-received`, 'observed', 'equals', role === 'sender' ? (entry.agentCount - 1) * 6 : 2]
                    ] as const
                ) {
                    expect(assertions).toContainEqual(expect.objectContaining({
                        source: { recipeId, commandId, path },
                        predicate: { operator, expected }
                    }));
                }
                if (role === 'sender') {
                    expect(assertions).toContainEqual(expect.objectContaining({
                        source: { recipeId, commandId: `${recipeId}-shot-arrivals`, path: 'passed' },
                        predicate: { operator: 'equals', expected: (entry.agentCount - 1) * 18 }
                    }));
                    for (const event of ['start', 'end']) {
                        expect(assertions).toContainEqual(expect.objectContaining({
                            source: { recipeId, commandId: `${recipeId}-${event}-receipt`, path: 'confirmedRecipientPeerIds.length' },
                            predicate: { operator: 'equals', expected: entry.agentCount - 1 }
                        }));
                    }
                }
                else {
                    expect(commands.find((command) => command.commandId === `${recipeId}-shots`)).toMatchObject({ count: 6, intervalMs: 0 });
                    expect(sends.map((send) => 'handleId' in send ? send.handleId : undefined))
                        .toEqual(Array.from({ length: 6 }, (_, index) => `${recipeId}-shot-${index + 1}`));
                    for (const [index, send] of sends.entries()) {
                        expect(send).toMatchObject({
                            payload: { payload: { seq: index + 1, payload: { shot: { seq: index + 1, sessionId: '{auth.sessionId}' } } } }
                        });
                    }
                    for (const event of ['started', 'ended']) {
                        expect(assertions).toContainEqual(expect.objectContaining({
                            source: { recipeId, commandId: `${recipeId}-${event}-arrival`, path: 'matched' },
                            predicate: { operator: 'equals', expected: true }
                        }));
                    }
                }
            }
        }
    });
});
