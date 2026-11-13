import { load as loadYaml } from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createHetznerDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';
import {
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER
} from '../../../apps/rallar-black-box/src/hetzner/hetzner-manifest-entry.ts';
import { createWorldFleetDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/world-fleet-distributed-manifests.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const repoRoot = path.resolve(__dirname, '../../..');

/** The time limit of the GitHub-hosted job that runs a hosted fleet's headless agents for the whole distributed run. */
async function readHostedAgentJobTimeoutSeconds(): Promise<number> {
    const workflow = loadYaml(
        await readFile(path.join(repoRoot, '.github/workflows/github-free-distributed-recipe.yml'), 'utf8')
    );
    return decodeHostedAgentJobTimeoutMinutes(workflow).fold(
        (issue) => {
            throw new Error(issue);
        },
        (minutes) => minutes * 60
    );
}

function decodeHostedAgentJobTimeoutMinutes(value: unknown): Either<string, number> {
    const schema = {
        type: 'object',
        required: ['jobs'],
        properties: {
            jobs: {
                type: 'object',
                required: ['github-agents'],
                properties: {
                    'github-agents': {
                        type: 'object',
                        required: ['timeout-minutes'],
                        properties: { 'timeout-minutes': { type: 'integer' } }
                    }
                }
            }
        }
    };
    return validateJsonSchema(schema, value).ok
        ? Either.ofRight((value as { jobs: { 'github-agents': { 'timeout-minutes': number; }; }; }).jobs['github-agents']['timeout-minutes'])
        : Either.ofLeft('The hosted agent job names no integer timeout-minutes.');
}

const MATRIX_AGENT_COUNTS = [10, 15, 20, 30] as const;
const MATRIX_DURATION_SECONDS = [30, 300] as const;
const MATRIX_RATE_HZ = [10, 20] as const;
const MATRIX_PROFILES = ['principal', 'all-peer'] as const;

function toDurationLabel(seconds: number): string {
    return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

function toExpectedMatrixDiagnosticPaths(): readonly string[] {
    return MATRIX_AGENT_COUNTS.flatMap((agentCount) =>
        MATRIX_DURATION_SECONDS.flatMap((durationSeconds) =>
            MATRIX_RATE_HZ.flatMap((rateHz) =>
                MATRIX_PROFILES.map((profile) =>
                    `apps/rallar-black-box/manifests/hetzner/diagnostic/matrix/rtc-messages-${profile}-${agentCount}-agent-${
                        toDurationLabel(durationSeconds)
                    }-${rateHz}hz-tree.json`
                )
            )
        )
    );
}

describe('Hetzner multicast workloads', () => {
    it('adds 50-agent messages.rtc multicast manifests with tree, mesh, and long-run metadata', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const byId = new Map(catalog.map((entry) => [entry.manifest.distributedRunId, entry]));
        const principalTree = byId.get('hetzner-rtc-messages-principal-50-agent-30s-20hz-tree');
        const principalMesh = byId.get('hetzner-rtc-messages-principal-50-agent-30s-20hz-mesh');
        const allPeerShort = byId.get('hetzner-rtc-messages-all-peer-50-agent-30s-5hz-tree');
        const allPeerDiagnostic = byId.get('hetzner-diagnostic-rtc-messages-all-peer-50-agent-30s-20hz-tree');
        const principalLong = byId.get('hetzner-diagnostic-rtc-messages-principal-50-agent-60m-20hz-tree');
        const allPeerLong20 = byId.get('hetzner-diagnostic-rtc-messages-all-peer-50-agent-60m-20hz-tree');

        expect(principalTree?.diagnostic).toBe(false);
        expect(principalTree?.manifest.metadata).toMatchObject({
            topologyProfile: 'tree',
            expectedDurationSeconds: 30,
            // Manifest 07: ack 30 s + barrier 15 s + the receiver's ensure-group and ensure-member 35 s each, connect
            // 115 s (two 30 s server completion waits and a 5 s margin for the SDK connect, 45 s readiness, 5 s margin),
            // 31 delivery-poll pauses of 5 s and 7 relay-hold pauses of 1 s.
            recommendedTerminalTimeoutSeconds: 30 + 15 + 35 + 35 + (65 + 45 + 5) + 155 + 7,
            transport: 'messages.rtc',
            participantCount: 50,
            rateHz: 20,
            receiverDelivery: {
                expectedInboundMessages: 600,
                minExpectedInboundMessages: 570,
                minReceiveRatio: 0.95
            },
            loadEstimate: {
                streamFrames: 600,
                logicalFanoutMessages: 29400
            },
            rtcTopologyEnv: {
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '51'
            }
        });
        expect(principalMesh?.manifest.metadata).toMatchObject({
            topologyProfile: 'mesh',
            rtcTopologyEnv: {
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '16'
            }
        });
        expect(allPeerShort?.manifest.metadata).toMatchObject({
            topologyProfile: 'tree',
            expectedDurationSeconds: 30,
            // Manifest 09: ack 30 s + barrier 15 s + ensure-group and ensure-member 35 s each, connect 115 s, 5 settle
            // pauses of 1 s, the 29.8 s stream schedule and its 5 s drain, 24 delivery-poll pauses of 5 s and 120
            // relay-hold pauses of 1 s, rounded up to the second.
            recommendedTerminalTimeoutSeconds: Math.ceil(30 + 15 + 35 + 35 + (65 + 45 + 5) + 5 + 29.8 + 5 + 120 + 120),
            receiverDelivery: {
                expectedInboundMessages: 7350,
                minExpectedInboundMessages: 6615,
                minReceiveRatio: 0.9
            },
            loadEstimate: {
                streamFrames: 7500,
                logicalFanoutMessages: 367500
            }
        });
        expect(allPeerDiagnostic?.diagnostic).toBe(true);
        expect(allPeerDiagnostic?.manifest.metadata).toMatchObject({
            expectedDurationSeconds: 30,
            receiverDelivery: {
                expectedInboundMessages: 29400,
                minExpectedInboundMessages: 23520,
                minReceiveRatio: 0.8
            }
        });
        expect(principalLong?.manifest.metadata).toMatchObject({
            diagnostic: true,
            expectedDurationSeconds: 3600,
            loadEstimate: {
                streamFrames: 72000,
                logicalFanoutMessages: 3528000
            }
        });
        expect(allPeerLong20?.manifest.metadata).toMatchObject({
            diagnostic: true,
            expectedDurationSeconds: 3600,
            loadEstimate: {
                streamFrames: 3600000,
                logicalFanoutMessages: 176400000
            }
        });
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(allPeerDiagnostic?.filePath);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(principalLong?.filePath);
    });

    it('labels the short 50-agent principal tree manifest as the GitHub Free smoke candidate', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/07-rtc-messages-principal-50-agent-30s-20hz-tree.json'));

        expect(entry).toBeDefined();
        expect(entry?.manifest.metadata?.catalogProfiles).toEqual(
            expect.arrayContaining(['github-free-smoke', '50-agent', 'tree'])
        );
    });

    it('adds 15- and 30-agent mainline alternatives for the three 50-agent multicast recipes', () => {
        const byId = new Map(
            createHetznerDistributedManifestCatalog().map((entry) => [entry.manifest.distributedRunId, entry])
        );

        for (const agentCount of [15, 30]) {
            const principalTree = byId.get(
                `hetzner-rtc-messages-principal-${agentCount}-agent-30s-20hz-tree`
            );
            const principalMesh = byId.get(
                `hetzner-rtc-messages-principal-${agentCount}-agent-30s-20hz-mesh`
            );
            const allPeerTree = byId.get(
                `hetzner-rtc-messages-all-peer-${agentCount}-agent-30s-5hz-tree`
            );
            const principalFrames = 30 * 20;
            const allPeerFrames = (agentCount - 1) * 30 * 5;

            expect(principalTree?.diagnostic).toBe(false);
            expect(principalTree?.agentCount).toBe(agentCount);
            expect(principalTree?.manifest.metadata).toMatchObject({
                topologyProfile: 'tree',
                participantCount: agentCount,
                senderCount: 1,
                receiverDelivery: {
                    expectedInboundMessages: principalFrames,
                    minExpectedInboundMessages: Math.floor(principalFrames * 0.95),
                    minReceiveRatio: 0.95
                },
                loadEstimate: {
                    streamFrames: principalFrames,
                    logicalFanoutMessages: principalFrames * (agentCount - 1)
                },
                rtcTopologyEnv: {
                    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: String(agentCount + 1)
                }
            });
            expect(principalTree?.manifest.recipes.map((selection) => selection.role)).toEqual([
                'sender',
                'receiver'
            ]);

            expect(principalMesh?.diagnostic).toBe(false);
            expect(principalMesh?.agentCount).toBe(agentCount);
            expect(principalMesh?.manifest.metadata).toMatchObject({
                topologyProfile: 'mesh',
                participantCount: agentCount,
                senderCount: 1,
                receiverDelivery: {
                    expectedInboundMessages: principalFrames,
                    minExpectedInboundMessages: Math.floor(principalFrames * 0.95),
                    minReceiveRatio: 0.95
                },
                rtcTopologyEnv: {
                    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '16'
                }
            });

            expect(allPeerTree?.diagnostic).toBe(false);
            expect(allPeerTree?.agentCount).toBe(agentCount);
            expect(allPeerTree?.manifest.metadata).toMatchObject({
                topologyProfile: 'tree',
                participantCount: agentCount,
                senderCount: agentCount,
                receiverDelivery: {
                    expectedInboundMessages: allPeerFrames,
                    minExpectedInboundMessages: Math.floor(allPeerFrames * 0.9),
                    minReceiveRatio: 0.9
                },
                loadEstimate: {
                    streamFrames: agentCount * 30 * 5,
                    logicalFanoutMessages: agentCount * 30 * 5 * (agentCount - 1)
                },
                rtcTopologyEnv: {
                    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: String(agentCount + 1)
                }
            });
        }
    });

    it('adds the 15-agent 78-minute principal tree that reads every agent ledger every 30 s mid-stream', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.manifest.distributedRunId === 'hetzner-rtc-messages-principal-15-agent-78m-2hz-tree');
        const [sender, receiver] = entry?.manifest.recipes ?? [];
        const senderWindow = sender?.recipe?.commands.find((command) => command.kind === 'parallel');

        expect(entry?.filePath).toBe(
            'apps/rallar-black-box/manifests/hetzner/23-rtc-messages-principal-15-agent-78m-2hz-tree.json'
        );
        expect(entry?.diagnostic).toBe(false);
        expect(entry?.agentCount).toBe(15);
        expect(entry?.manifest.eventHistory).toEqual({ mode: 'recent', maxEvents: 10_000 });
        expect(entry?.manifest.metadata).toMatchObject({
            topologyProfile: 'tree',
            participantCount: 15,
            senderCount: 1,
            rateHz: 2,
            expectedDurationSeconds: 4_680,
            receiverDelivery: { expectedInboundMessages: 9_360, minExpectedInboundMessages: 8_892 },
            rtcTopologyEnv: { RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '16' }
        });
        expect(senderWindow).toMatchObject({
            kind: 'parallel',
            groups: [
                { groupId: 'stream', commands: [{ kind: 'rtc.stream', count: 9_360, intervalMs: 500 }] },
                {
                    groupId: 'mid-stream-stats',
                    commands: [{ kind: 'loop', count: 157, intervalMs: 30_000, commands: [{ kind: 'stats' }] }]
                }
            ]
        });
        expect(receiver?.recipe?.commands.find((command) => command.kind === 'loop')).toMatchObject({
            commandId: 'rtc-messages-principal-receiver-delivery-poll',
            until: 'first-success',
            count: 162,
            intervalMs: 30_000
        });
        for (const selection of entry?.manifest.recipes ?? []) {
            expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe: selection.recipe })).toEqual({
                ok: true
            });
        }
    });

    it('bounds the event history of the 78-minute run alone; every other manifest keeps the agents\' configured history', () => {
        const withHistory = createHetznerDistributedManifestCatalog()
            .filter((entry) => 'eventHistory' in entry.manifest)
            .map((entry) => entry.manifest.distributedRunId);

        expect(withHistory).toEqual(['hetzner-rtc-messages-principal-15-agent-78m-2hz-tree']);
    });

    it('recommends the terminal timeout its ack, barrier and slowest recipe budget add up to for every multicast run', () => {
        const multicast = createHetznerDistributedManifestCatalog()
            .filter((entry) => /-rtc-messages-(principal|all-peer)-/.test(entry.manifest.distributedRunId));

        expect(multicast.length).toBeGreaterThan(0);
        for (const { manifest } of multicast) {
            expect(manifest.metadata?.recommendedTerminalTimeoutSeconds, manifest.distributedRunId).toBe(
                computeDistributedRunTerminalTimeoutSeconds({
                    recipes: manifest.recipes.flatMap((selection) => selection.recipe ? [selection.recipe] : []),
                    ackTimeoutMs: manifest.ackTimeoutMs,
                    barrier: manifest.barrier
                })
            );
        }
    });

    it('ends every run a hosted agent job can stream within that job\'s own time limit', async () => {
        const jobTimeoutSeconds = await readHostedAgentJobTimeoutSeconds();
        const hostedRuns = [...createHetznerDistributedManifestCatalog(), ...createWorldFleetDistributedManifestCatalog()]
            .map((entry) => entry.manifest)
            .filter((manifest) =>
                typeof manifest.metadata?.recommendedTerminalTimeoutSeconds === 'number' &&
                Number(manifest.metadata.expectedDurationSeconds ?? 0) < jobTimeoutSeconds
            );

        expect(hostedRuns.length).toBeGreaterThan(0);
        for (const manifest of hostedRuns) {
            expect(manifest.metadata?.recommendedTerminalTimeoutSeconds, manifest.distributedRunId)
                .toBeLessThanOrEqual(jobTimeoutSeconds);
        }
    });

    it('adds medium-scale messages.rtc multicast matrix manifests for 10 to 30 agents', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const matrix = catalog.filter((entry) => entry.filePath.includes('/diagnostic/matrix/rtc-messages-'));
        const byId = new Map(catalog.map((entry) => [entry.manifest.distributedRunId, entry]));

        expect(matrix.map((entry) => entry.filePath)).toEqual(toExpectedMatrixDiagnosticPaths());
        expect(matrix).toHaveLength(
            MATRIX_AGENT_COUNTS.length * MATRIX_DURATION_SECONDS.length * MATRIX_RATE_HZ.length * MATRIX_PROFILES.length
        );

        for (const agentCount of MATRIX_AGENT_COUNTS) {
            for (const durationSeconds of MATRIX_DURATION_SECONDS) {
                for (const rateHz of MATRIX_RATE_HZ) {
                    const frameCount = durationSeconds * rateHz;
                    const label = toDurationLabel(durationSeconds);
                    const principal = byId.get(
                        `hetzner-diagnostic-rtc-messages-principal-${agentCount}-agent-${label}-${rateHz}hz-tree`
                    );
                    const allPeer = byId.get(
                        `hetzner-diagnostic-rtc-messages-all-peer-${agentCount}-agent-${label}-${rateHz}hz-tree`
                    );

                    expect(principal?.diagnostic, `${agentCount} principal ${label} ${rateHz}Hz`).toBe(true);
                    expect(principal?.agentCount).toBe(agentCount);
                    expect(principal?.manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
                    expect(principal?.manifest.metadata).toMatchObject({
                        topologyProfile: 'tree',
                        transport: 'messages.rtc',
                        participantCount: agentCount,
                        senderCount: 1,
                        expectedDurationSeconds: durationSeconds,
                        rateHz,
                        receiverDelivery: {
                            expectedInboundMessages: frameCount,
                            minExpectedInboundMessages: Math.floor(frameCount * 0.95),
                            minReceiveRatio: 0.95
                        },
                        loadEstimate: {
                            streamFrames: frameCount,
                            logicalFanoutMessages: frameCount * (agentCount - 1)
                        }
                    });
                    expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(principal?.filePath);

                    const allPeerExpectedInbound = (agentCount - 1) * frameCount;
                    const allPeerMinRatio = rateHz === 20 ? 0.8 : 0.85;
                    expect(allPeer?.diagnostic, `${agentCount} all-peer ${label} ${rateHz}Hz`).toBe(true);
                    expect(allPeer?.agentCount).toBe(agentCount);
                    expect(allPeer?.manifest.recipes).toHaveLength(1);
                    expect(allPeer?.manifest.metadata).toMatchObject({
                        topologyProfile: 'tree',
                        transport: 'messages.rtc',
                        participantCount: agentCount,
                        senderCount: agentCount,
                        expectedDurationSeconds: durationSeconds,
                        rateHz,
                        receiverDelivery: {
                            expectedInboundMessages: allPeerExpectedInbound,
                            minExpectedInboundMessages: Math.floor(allPeerExpectedInbound * allPeerMinRatio),
                            minReceiveRatio: allPeerMinRatio
                        },
                        loadEstimate: {
                            streamFrames: agentCount * frameCount,
                            logicalFanoutMessages: agentCount * frameCount * (agentCount - 1)
                        }
                    });
                    expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(allPeer?.filePath);
                }
            }
        }
    });
});
