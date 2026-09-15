import {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    createHetznerGroupAssertions,
    createHetznerGroupAssertionsRecipe
} from './create-hetzner-group-assertions-recipe.ts';
import { createHetznerProviderParityRecipe } from './create-hetzner-provider-parity-recipe.ts';
import { createHetznerRtcAbsenceWaitRecipe } from './create-hetzner-rtc-absence-wait-recipe.ts';
import type { HetznerDistributedManifestEntry } from './hetzner-manifest-entry.ts';
import {
    createManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP
} from './hetzner-manifest-entry.ts';

export function createDiagnosticRtcRealtime2Agent20hzStressEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-realtime-2-agent-20hz-stress.json',
        title: 'RTC realtime 2-agent 20 Hz stress',
        description: 'Strict 20 Hz RTC realtime stress run for stream pacing and in-flight backlog diagnostics.',
        distributedRunId: 'hetzner-diagnostic-rtc-realtime-2-agent-20hz-stress',
        recipe: createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            rateHz: 20,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
            executionMode: 'stream',
            stream: {
                maxDroppedFrames: 20
            }
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stress', 'diagnostic'],
        live: true,
        diagnostic: true,
        expectedFailure: false,
        stress: true
    });
}

export function createDiagnosticExpectedFailure1AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json',
        title: 'Expected failure 1-agent',
        description: 'Diagnostic run that intentionally fails to verify artifact analyzer fix proposals.',
        distributedRunId: 'hetzner-diagnostic-expected-failure-1-agent',
        recipe: toFixtureRecipe('expected-failure'),
        agentCount: 1,
        profiles: ['negative', 'diagnostic'],
        live: false,
        diagnostic: true,
        expectedFailure: true
    });
}

export function createDiagnosticBarrierHealth2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
        title: 'Barrier health 2-agent',
        description: 'Diagnostic run that validates synchronized barrier orchestration before start.',
        distributedRunId: 'hetzner-diagnostic-barrier-health-2-agent',
        recipe: createHealthRecipe('barrier-health'),
        agentCount: 2,
        profiles: ['health', 'barrier', 'diagnostic'],
        live: false,
        diagnostic: true,
        barrier: true
    });
}

export function createGroupAssertions2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[16],
        title: 'Group assertions 2-agent',
        description: 'Coordinator-evaluated group assertions: allEqual convergence over the ' +
            'shared group snapshot and noneMatch isolation over per-agent absence windows.',
        distributedRunId: 'hetzner-group-assertions-2-agent',
        recipe: createHetznerGroupAssertionsRecipe(HETZNER_DISTRIBUTED_MANIFEST_GROUP),
        agentCount: 2,
        profiles: ['rtc', 'group-assertions', 'isolation', 'extended'],
        live: true,
        groupAssertions: createHetznerGroupAssertions(2)
    });
}

export function createRtcAbsenceWait2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[15],
        title: 'RTC absence wait 2-agent',
        description: 'Same-room positive control delivery followed by absence waits proving ' +
            'no leak-probe frame and no silent rtc send failure.',
        distributedRunId: 'hetzner-rtc-absence-wait-2-agent',
        recipe: createHetznerRtcAbsenceWaitRecipe(HETZNER_DISTRIBUTED_MANIFEST_GROUP),
        agentCount: 2,
        profiles: ['rtc', 'absence', 'isolation', 'extended'],
        live: true
    });
}

export function createRtcRealtime3Agent15sEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[5],
        title: 'RTC realtime 3-agent 15s',
        description: 'Heavier 10 Hz RTC realtime run for three-agent load and percentile baselines.',
        distributedRunId: 'hetzner-rtc-realtime-3-agent-15s',
        recipe: createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 15,
            rateHz: 10,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 2,
            readyTimeoutMs: 10_000,
            executionMode: 'stream',
            stream: {
                maxDroppedFrames: 15
            }
        }),
        agentCount: 3,
        profiles: ['rtc', 'realtime', 'load'],
        live: true
    });
}

export function createRtcRealtimeStability2Agent30s20hzEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[4],
        title: 'RTC realtime stability 2-agent 30s 20 Hz',
        description:
            'Highest-rate 20 Hz RTC realtime stability stream with one sender and one receiver for sustained pacing evidence.',
        distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s-20hz',
        recipes: createRtcRealtime20HzSenderReceiverRecipes(),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stability', 'extended'],
        live: true,
        targetAgentIds: ['controller-01', 'controller-02'],
        targetPolicyMode: 'role-map',
        rolePattern: 'sender-receiver'
    });
}

export function createRtcRealtimeStability2Agent30s15hzEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[3],
        title: 'RTC realtime stability 2-agent 30s 15 Hz',
        description: 'Higher-rate 15 Hz RTC realtime stability stream for sustained pacing evidence.',
        distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s-15hz',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
            durationSeconds: 30,
            rateHz: 15,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
            stream: {
                maxInFlight: 64,
                maxDroppedFrames: 22,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000
            }
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stability', 'extended'],
        live: true
    });
}

export function createRtcRealtimeStability2Agent30s10hzEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[2],
        title: 'RTC realtime stability 2-agent 30s 10 Hz',
        description: 'Longer 10 Hz RTC realtime stability stream for sustained pacing evidence.',
        distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s-10hz',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
            durationSeconds: 30,
            rateHz: 10,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
            stream: {
                maxInFlight: 64,
                maxDroppedFrames: 15,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000
            }
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stability', 'extended'],
        live: true
    });
}

export function createRtcRealtimeStability2Agent30sEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[1],
        title: 'RTC realtime stability 2-agent 30s',
        description: 'Longer 5 Hz RTC realtime stability stream for sustained pacing evidence.',
        distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
            durationSeconds: 30,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stability', 'extended'],
        live: true
    });
}

export function createRtcRealtime2Agent5sEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[0],
        title: 'RTC realtime 2-agent 5s',
        description: 'Short 10 Hz RTC realtime run for first-pass RTT and event-rate performance baseline.',
        distributedRunId: 'hetzner-rtc-realtime-2-agent-5s',
        recipe: createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 5,
            rateHz: 10,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
            executionMode: 'stream',
            stream: {
                maxDroppedFrames: 5
            }
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'baseline'],
        live: true
    });
}

export function createRtcRealtimeStability2Agent5sEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[4],
        title: 'RTC realtime stability 2-agent 5s',
        description: 'Lower-risk 5 Hz RTC realtime stream for green stability and first-pass pacing evidence.',
        distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-5s',
        recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        }),
        agentCount: 2,
        profiles: ['rtc', 'realtime', 'stability', 'green'],
        live: true,
        mainline: true
    });
}

export function createProviderParity2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[3],
        title: 'Provider parity 2-agent',
        description:
            'Broader browser-rallar provider parity check for connect, direct, multicast, broadcast, health, close, and reset.',
        distributedRunId: 'hetzner-provider-parity-2-agent',
        recipe: createHetznerProviderParityRecipe(HETZNER_DISTRIBUTED_MANIFEST_GROUP),
        agentCount: 2,
        profiles: ['rtc', 'parity'],
        live: true,
        mainline: true
    });
}

export function createRtcSmoke2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[2],
        title: 'RTC smoke 2-agent',
        description: 'Live RTC connect/send/stats smoke against the Hetzner headless room.',
        distributedRunId: 'hetzner-rtc-smoke-2-agent',
        recipe: createRallarBlackBoxRtcSmokeRecipe({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyPeerCount: 1,
            readyTimeoutMs: 10_000
        }),
        agentCount: 2,
        profiles: ['rtc', 'smoke'],
        live: true,
        mainline: true
    });
}

export function createCompositeEvidence2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[1],
        title: 'Composite evidence 2-agent',
        description: 'Loop, parallel, wait, and assert evidence without relying on live RTC delivery.',
        distributedRunId: 'hetzner-composite-evidence-2-agent',
        recipe: toFixtureRecipe('composite-evidence'),
        agentCount: 2,
        profiles: ['composite', 'smoke'],
        live: false,
        mainline: true
    });
}

export function createHealth2AgentEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[0],
        title: 'Health 2-agent',
        description: 'Cheap headless control-agent reachability check using health and stats commands.',
        distributedRunId: 'hetzner-health-2-agent',
        recipe: createHealthRecipe(),
        agentCount: 2,
        profiles: ['health', 'smoke'],
        live: false,
        mainline: true
    });
}

function createRtcRealtime20HzSenderReceiverRecipes(): readonly RallarBlackBoxTestRecipe[] {
    const sender = createRallarBlackBoxRtcRealtimeStabilityRecipe({
        durationSeconds: 30,
        rateHz: 20,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        readyPeerCount: 1,
        readyTimeoutMs: 10_000,
        stream: {
            maxInFlight: 64,
            maxDroppedFrames: 30,
            maxP95SendDurationMs: 2500,
            maxP99SendDurationMs: 4000
        }
    });
    return [
        sender,
        toRtcRealtime20HzReceiverRecipe(sender)
    ];
}

function toRtcRealtime20HzReceiverRecipe(sender: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    const receiverSetup = sender.commands.filter((command) =>
        command.kind === 'http.request' || command.kind === 'rtc.connect'
    );
    return {
        schemaVersion: 1,
        recipeId: 'rtc-realtime-stability-receiver',
        name: 'RTC realtime stability receiver hold',
        description: 'Connect RTC and keep the receiver alive while the 20 Hz sender stream runs.',
        continueOnFailure: false,
        metadata: {
            ...sender.metadata,
            profile: 'rtc-realtime-stability-receiver',
            role: 'receiver'
        },
        commands: [
            ...receiverSetup,
            {
                kind: 'loop',
                commandId: 'rtc-realtime-receiver-stats-loop',
                count: 35,
                intervalMs: 1_000,
                maxCommands: 35,
                metadata: {
                    realtime: {
                        role: 'receiver',
                        rateHz: 20,
                        durationSeconds: 30,
                        frameCount: 600
                    }
                },
                commands: [
                    {
                        kind: 'stats',
                        commandId: 'rtc-realtime-receiver-stats',
                        metadata: {
                            realtime: {
                                role: 'receiver',
                                rateHz: 20,
                                durationSeconds: 30,
                                frameCount: 600
                            }
                        }
                    }
                ]
            }
        ]
    };
}

function createHealthRecipe(recipeId = 'hetzner-health-recipe'): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId,
        name: 'Hetzner headless health',
        description: 'Verifies browser control-agent command dispatch and stats collection.',
        continueOnFailure: false,
        commands: [
            {
                kind: 'health',
                commandId: 'headless-health',
                label: 'Headless health'
            },
            {
                kind: 'stats',
                commandId: 'headless-stats'
            }
        ]
    };
}

function toFixtureRecipe(fixtureId: string): RallarBlackBoxTestRecipe {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find((candidate) => candidate.fixtureId === fixtureId);
    if (!fixture) {
        throw new Error(`Unknown Rallar black-box recipe fixture: ${fixtureId}`);
    }
    return {
        ...fixture.recipe
    };
}
