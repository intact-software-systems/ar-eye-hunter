import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import {
    buildDistributedRunManifest,
    type DistributedRecipeCatalogItem,
    type DistributedRecipeRolePattern,
    type DistributedRecipeTargetPolicyMode,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import {
    createHetznerProviderParityRecipe,
} from './hetzner/create-hetzner-provider-parity-recipe.ts';

export const HETZNER_DISTRIBUTED_MANIFEST_GROUP: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'hetzner-headless-room',
};

export const HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER = [
    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json',
] as const;

export const HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER = [
    'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json',
    'apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json',
    'apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json',
    'apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json',
    'apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json',
    'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json',
    'apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json',
    'apps/rallar-black-box/manifests/hetzner/08-rtc-messages-principal-50-agent-30s-20hz-mesh.json',
    'apps/rallar-black-box/manifests/hetzner/09-rtc-messages-all-peer-50-agent-30s-5hz-tree.json',
    'apps/rallar-black-box/manifests/hetzner/10-rtc-messages-principal-15-agent-30s-20hz-tree.json',
    'apps/rallar-black-box/manifests/hetzner/11-rtc-messages-principal-15-agent-30s-20hz-mesh.json',
    'apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json',
    'apps/rallar-black-box/manifests/hetzner/13-rtc-messages-principal-30-agent-30s-20hz-tree.json',
    'apps/rallar-black-box/manifests/hetzner/14-rtc-messages-principal-30-agent-30s-20hz-mesh.json',
    'apps/rallar-black-box/manifests/hetzner/15-rtc-messages-all-peer-30-agent-30s-5hz-tree.json',
] as const;

export type HetznerDistributedManifestEntry = Readonly<{
    filePath: string;
    title: string;
    description: string;
    agentCount: number;
    mainline: boolean;
    diagnostic: boolean;
    manifest: RallarBlackBoxDistributedRunManifest;
}>;

type ManifestCatalogInput = Readonly<{
    filePath: string;
    title: string;
    description: string;
    distributedRunId: string;
    recipe?: RallarBlackBoxTestRecipe;
    recipes?: readonly RallarBlackBoxTestRecipe[];
    agentCount: number;
    profiles: readonly string[];
    live: boolean;
    targetAgentIds?: readonly string[];
    targetPolicyMode?: DistributedRecipeTargetPolicyMode;
    rolePattern?: DistributedRecipeRolePattern;
    mainline?: boolean;
    diagnostic?: boolean;
    expectedFailure?: boolean;
    stress?: boolean;
    barrier?: boolean;
    metadata?: Readonly<Record<string, unknown>>;
}>;

const DEFAULT_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_CONTROL_RUN_ID = 'hetzner-manifest-template-control-run';
const RTC_MESSAGES_MATRIX_AGENT_COUNTS = [10, 15, 20, 30] as const;
const RTC_MESSAGES_MATRIX_DURATION_SECONDS = [30, 300] as const;
const RTC_MESSAGES_MATRIX_RATE_HZ = [10, 20] as const;
const RTC_MESSAGES_MATRIX_PROFILES = ['principal', 'all-peer'] as const;
const RTC_MESSAGES_MAINLINE_ALTERNATIVE_AGENT_COUNTS = [15, 30] as const;

export function buildHetznerDistributedManifestCatalog(): readonly HetznerDistributedManifestEntry[] {
    return [
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[0],
            title: 'Health 2-agent',
            description: 'Cheap headless control-agent reachability check using health and stats commands.',
            distributedRunId: 'hetzner-health-2-agent',
            recipe: createHealthRecipe(),
            agentCount: 2,
            profiles: ['health', 'smoke'],
            live: false,
            mainline: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[1],
            title: 'Composite evidence 2-agent',
            description: 'Loop, parallel, wait, and assert evidence without relying on live RTC delivery.',
            distributedRunId: 'hetzner-composite-evidence-2-agent',
            recipe: fixtureRecipe('composite-evidence'),
            agentCount: 2,
            profiles: ['composite', 'smoke'],
            live: false,
            mainline: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[2],
            title: 'RTC smoke 2-agent',
            description: 'Live RTC connect/send/stats smoke against the Hetzner headless room.',
            distributedRunId: 'hetzner-rtc-smoke-2-agent',
            recipe: createRallarBlackBoxRtcSmokeRecipe({
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000,
            }),
            agentCount: 2,
            profiles: ['rtc', 'smoke'],
            live: true,
            mainline: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[3],
            title: 'Provider parity 2-agent',
            description: 'Broader browser-rallar provider parity check for connect, direct, multicast, broadcast, health, close, and reset.',
            distributedRunId: 'hetzner-provider-parity-2-agent',
            recipe: createHetznerProviderParityRecipe(HETZNER_DISTRIBUTED_MANIFEST_GROUP),
            agentCount: 2,
            profiles: ['rtc', 'parity'],
            live: true,
            mainline: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER[4],
            title: 'RTC realtime stability 2-agent 5s',
            description: 'Lower-risk 5 Hz RTC realtime stream for green stability and first-pass pacing evidence.',
            distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-5s',
            recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000,
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stability', 'green'],
            live: true,
            mainline: true,
        }),
        buildManifestEntry({
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
                    maxDroppedFrames: 5,
                },
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'baseline'],
            live: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[1],
            title: 'RTC realtime stability 2-agent 30s',
            description: 'Longer 5 Hz RTC realtime stability stream for sustained pacing evidence.',
            distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s',
            recipe: createRallarBlackBoxRtcRealtimeStabilityRecipe({
                durationSeconds: 30,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000,
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stability', 'extended'],
            live: true,
        }),
        buildManifestEntry({
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
                    maxP99SendDurationMs: 1000,
                },
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stability', 'extended'],
            live: true,
        }),
        buildManifestEntry({
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
                    maxP99SendDurationMs: 1000,
                },
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stability', 'extended'],
            live: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[4],
            title: 'RTC realtime stability 2-agent 30s 20 Hz',
            description: 'Highest-rate 20 Hz RTC realtime stability stream with one sender and one receiver for sustained pacing evidence.',
            distributedRunId: 'hetzner-rtc-realtime-stability-2-agent-30s-20hz',
            recipes: createRtcRealtime20HzSenderReceiverRecipes(),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stability', 'extended'],
            live: true,
            targetAgentIds: ['controller-01', 'controller-02'],
            targetPolicyMode: 'role-map',
            rolePattern: 'sender-receiver',
        }),
        buildManifestEntry({
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
                    maxDroppedFrames: 15,
                },
            }),
            agentCount: 3,
            profiles: ['rtc', 'realtime', 'load'],
            live: true,
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[6],
            title: 'RTC messages principal 50-agent 30s 20 Hz tree',
            description: 'One principal headless sender multicasts RTC messages at 20 Hz to 49 receivers through a forced tree topology.',
            distributedRunId: 'hetzner-rtc-messages-principal-50-agent-30s-20hz-tree',
            recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
                participantCount: 50,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.95,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyTimeoutMs: 45_000,
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                },
            }),
            agentCount: 50,
            profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'tree', '50-agent', 'github-free-smoke', 'extended'],
            live: true,
            targetAgentIds: controllerAgentIds(50),
            targetPolicyMode: 'role-map',
            rolePattern: 'one-sender-many-receivers',
            barrier: true,
            metadata: multicastManifestMetadata({
                topologyProfile: 'tree',
                participantCount: 50,
                senderCount: 1,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.95,
                receiverExpectedFrames: 600,
                recommendedTerminalTimeoutSeconds: 330,
                catalogProfiles: ['github-free-smoke', '50-agent', 'tree'],
            }),
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[7],
            title: 'RTC messages principal 50-agent 30s 20 Hz mesh',
            description: 'One principal headless sender multicasts RTC messages at 20 Hz to 49 receivers through the default mesh topology.',
            distributedRunId: 'hetzner-rtc-messages-principal-50-agent-30s-20hz-mesh',
            recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
                participantCount: 50,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.95,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyTimeoutMs: 45_000,
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                },
            }),
            agentCount: 50,
            profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'mesh', 'extended'],
            live: true,
            targetAgentIds: controllerAgentIds(50),
            targetPolicyMode: 'role-map',
            rolePattern: 'one-sender-many-receivers',
            barrier: true,
            metadata: multicastManifestMetadata({
                topologyProfile: 'mesh',
                participantCount: 50,
                senderCount: 1,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.95,
                receiverExpectedFrames: 600,
                recommendedTerminalTimeoutSeconds: 330,
            }),
        }),
        buildManifestEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[8],
            title: 'RTC messages all-peer 50-agent 30s 5 Hz tree',
            description: 'All 50 headless peers multicast RTC messages at 5 Hz through a forced tree topology.',
            distributedRunId: 'hetzner-rtc-messages-all-peer-50-agent-30s-5hz-tree',
            recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
                participantCount: 50,
                durationSeconds: 30,
                rateHz: 5,
                minReceiveRatio: 0.9,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyTimeoutMs: 45_000,
                stream: {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                },
            }),
            agentCount: 50,
            profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'extended'],
            live: true,
            barrier: true,
            metadata: multicastManifestMetadata({
                topologyProfile: 'tree',
                participantCount: 50,
                senderCount: 50,
                durationSeconds: 30,
                rateHz: 5,
                minReceiveRatio: 0.9,
                receiverExpectedFrames: 7_350,
                recommendedTerminalTimeoutSeconds: 330,
            }),
        }),
        ...buildRtcMessagesMainlineAlternativeEntries(),
        buildManifestEntry({
            filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
            title: 'Barrier health 2-agent',
            description: 'Diagnostic run that validates synchronized barrier orchestration before start.',
            distributedRunId: 'hetzner-diagnostic-barrier-health-2-agent',
            recipe: createHealthRecipe('barrier-health'),
            agentCount: 2,
            profiles: ['health', 'barrier', 'diagnostic'],
            live: false,
            diagnostic: true,
            barrier: true,
        }),
        buildManifestEntry({
            filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json',
            title: 'Expected failure 1-agent',
            description: 'Diagnostic run that intentionally fails to verify artifact analyzer fix proposals.',
            distributedRunId: 'hetzner-diagnostic-expected-failure-1-agent',
            recipe: fixtureRecipe('expected-failure'),
            agentCount: 1,
            profiles: ['negative', 'diagnostic'],
            live: false,
            diagnostic: true,
            expectedFailure: true,
        }),
        buildManifestEntry({
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
                    maxDroppedFrames: 20,
                },
            }),
            agentCount: 2,
            profiles: ['rtc', 'realtime', 'stress', 'diagnostic'],
            live: true,
            diagnostic: true,
            expectedFailure: false,
            stress: true,
        }),
        buildManifestEntry({
            filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-30s-20hz-tree.json',
            title: 'RTC messages all-peer 50-agent 30s 20 Hz tree diagnostic',
            description: 'Diagnostic 50-agent all-peer RTC messages multicast at 20 Hz through a forced tree topology.',
            distributedRunId: 'hetzner-diagnostic-rtc-messages-all-peer-50-agent-30s-20hz-tree',
            recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
                participantCount: 50,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.8,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyTimeoutMs: 45_000,
            }),
            agentCount: 50,
            profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'diagnostic'],
            live: true,
            diagnostic: true,
            stress: true,
            barrier: true,
            metadata: multicastManifestMetadata({
                topologyProfile: 'tree',
                participantCount: 50,
                senderCount: 50,
                durationSeconds: 30,
                rateHz: 20,
                minReceiveRatio: 0.8,
                receiverExpectedFrames: 29_400,
                recommendedTerminalTimeoutSeconds: 330,
            }),
        }),
        buildManifestEntry({
            filePath: 'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json',
            title: 'RTC messages principal 50-agent 60m 20 Hz tree diagnostic',
            description: 'Long diagnostic principal RTC messages multicast run for 60-minute tree soak validation.',
            distributedRunId: 'hetzner-diagnostic-rtc-messages-principal-50-agent-60m-20hz-tree',
            recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
                participantCount: 50,
                durationSeconds: 3_600,
                rateHz: 20,
                minReceiveRatio: 0.95,
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyTimeoutMs: 45_000,
                stream: {
                    progressEveryMs: 30_000,
                    sampleEvery: 100,
                    drainTimeoutMs: 30_000,
                    maxDroppedFrames: 3_600,
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000,
                },
            }),
            agentCount: 50,
            profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'tree', 'long', 'diagnostic'],
            live: true,
            targetAgentIds: controllerAgentIds(50),
            targetPolicyMode: 'role-map',
            rolePattern: 'one-sender-many-receivers',
            diagnostic: true,
            stress: true,
            barrier: true,
            metadata: multicastManifestMetadata({
                topologyProfile: 'tree',
                participantCount: 50,
                senderCount: 1,
                durationSeconds: 3_600,
                rateHz: 20,
                minReceiveRatio: 0.95,
                receiverExpectedFrames: 72_000,
                recommendedTerminalTimeoutSeconds: 3_900,
            }),
        }),
        ...[5, 10, 20].map(rateHz =>
            buildManifestEntry({
                filePath: `apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-60m-${rateHz}hz-tree.json`,
                title: `RTC messages all-peer 50-agent 60m ${rateHz} Hz tree diagnostic`,
                description: `Long diagnostic all-peer RTC messages multicast run at ${rateHz} Hz for 60-minute tree soak validation.`,
                distributedRunId: `hetzner-diagnostic-rtc-messages-all-peer-50-agent-60m-${rateHz}hz-tree`,
                recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
                    participantCount: 50,
                    durationSeconds: 3_600,
                    rateHz,
                    minReceiveRatio: rateHz === 20 ? 0.8 : rateHz === 10 ? 0.85 : 0.9,
                    group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                    readyTimeoutMs: 45_000,
                    stream: {
                        progressEveryMs: 30_000,
                        sampleEvery: 100,
                        drainTimeoutMs: 30_000,
                        maxDroppedFrames: Math.ceil(3_600 * rateHz * 0.05),
                        maxP95SendDurationMs: 2_500,
                        maxP99SendDurationMs: 4_000,
                    },
                }),
                agentCount: 50,
                profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'long', 'diagnostic'],
                live: true,
                diagnostic: true,
                stress: true,
                barrier: true,
                metadata: multicastManifestMetadata({
                    topologyProfile: 'tree',
                    participantCount: 50,
                    senderCount: 50,
                    durationSeconds: 3_600,
                    rateHz,
                    minReceiveRatio: rateHz === 20 ? 0.8 : rateHz === 10 ? 0.85 : 0.9,
                    receiverExpectedFrames: 49 * 3_600 * rateHz,
                    recommendedTerminalTimeoutSeconds: 4_200,
                }),
            })
        ),
        ...buildRtcMessagesMediumScaleMatrixEntries(),
    ];
}

function buildManifestEntry(input: ManifestCatalogInput): HetznerDistributedManifestEntry {
    const manifest = buildDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: DEFAULT_CONTROL_RUN_ID,
        displayName: input.title,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        recipes: catalogItems(input),
        targetAgentIds: input.targetAgentIds ?? [],
        targetPolicyMode: input.targetPolicyMode ?? 'all-online-group-members',
        rolePattern: input.rolePattern ?? 'all-agents',
        ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
        barrier: input.barrier || (input.live && input.agentCount >= 2)
            ? {
                  enabled: true,
                  timeoutMs: 15_000,
              }
            : undefined,
        startMode: 'manual',
        expectedParticipantCount: input.agentCount,
    });

    return {
        filePath: input.filePath,
        title: input.title,
        description: input.description,
        agentCount: input.agentCount,
        mainline: input.mainline === true,
        diagnostic: input.diagnostic === true,
        manifest: {
            ...manifest,
            description: input.description,
            metadata: {
                ...manifest.metadata,
                manifestSuite: 'hetzner-distributed',
                diagnostic: input.diagnostic === true,
                expectedFailure: input.expectedFailure === true,
                ...(input.stress === true ? { stress: true } : {}),
                ...(input.metadata ?? {}),
            },
        },
    };
}

function controllerAgentIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_value, index) =>
        `controller-${String(index + 1).padStart(2, '0')}`
    );
}

function multicastManifestMetadata(input: Readonly<{
    topologyProfile: 'tree' | 'mesh';
    treeMeshMinSize?: number;
    participantCount: number;
    senderCount: number;
    durationSeconds: number;
    rateHz: number;
    minReceiveRatio: number;
    receiverExpectedFrames: number;
    recommendedTerminalTimeoutSeconds: number;
    catalogProfiles?: readonly string[];
}>): Readonly<Record<string, unknown>> {
    const streamFrames = input.durationSeconds * input.rateHz * input.senderCount;
    return {
        topologyProfile: input.topologyProfile,
        transport: 'messages.rtc',
        participantCount: input.participantCount,
        senderCount: input.senderCount,
        receiverCount: input.senderCount === input.participantCount
            ? input.participantCount
            : input.participantCount - input.senderCount,
        rateHz: input.rateHz,
        expectedDurationSeconds: input.durationSeconds,
        recommendedTerminalTimeoutSeconds: input.recommendedTerminalTimeoutSeconds,
        ...(input.catalogProfiles ? { catalogProfiles: input.catalogProfiles } : {}),
        rtcTopologyEnv: {
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: input.topologyProfile === 'tree'
                ? String(input.treeMeshMinSize ?? 51)
                : '16',
        },
        receiverDelivery: {
            expectedInboundMessages: input.receiverExpectedFrames,
            minExpectedInboundMessages: Math.floor(input.receiverExpectedFrames * input.minReceiveRatio),
            minReceiveRatio: input.minReceiveRatio,
        },
        loadEstimate: {
            streamFrames,
            logicalFanoutMessages: streamFrames * (input.participantCount - 1),
        },
    };
}

function buildRtcMessagesMainlineAlternativeEntries(): readonly HetznerDistributedManifestEntry[] {
    return RTC_MESSAGES_MAINLINE_ALTERNATIVE_AGENT_COUNTS.flatMap(participantCount => {
        const pathOffset = participantCount === 15 ? 9 : 12;
        const [principalTreePath, principalMeshPath, allPeerTreePath] = [
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset]!,
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset + 1]!,
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset + 2]!,
        ];
        const principalRecipes = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000,
            },
        });
        const principalMetadata = {
            participantCount,
            senderCount: 1,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: 600,
            recommendedTerminalTimeoutSeconds: 330,
        } as const;

        return [
            buildManifestEntry({
                filePath: principalTreePath,
                title: `RTC messages principal ${participantCount}-agent 30s 20 Hz tree`,
                description: `One principal headless sender multicasts RTC messages at 20 Hz to ${participantCount - 1} receivers through a forced tree topology.`,
                distributedRunId: `hetzner-rtc-messages-principal-${participantCount}-agent-30s-20hz-tree`,
                recipes: principalRecipes,
                agentCount: participantCount,
                profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'tree', `${participantCount}-agent`, 'github-free-smoke', 'extended'],
                live: true,
                targetAgentIds: controllerAgentIds(participantCount),
                targetPolicyMode: 'role-map',
                rolePattern: 'one-sender-many-receivers',
                barrier: true,
                metadata: multicastManifestMetadata({
                    topologyProfile: 'tree',
                    treeMeshMinSize: participantCount + 1,
                    ...principalMetadata,
                    catalogProfiles: ['github-free-smoke', `${participantCount}-agent`, 'tree'],
                }),
            }),
            buildManifestEntry({
                filePath: principalMeshPath,
                title: `RTC messages principal ${participantCount}-agent 30s 20 Hz mesh`,
                description: `One principal headless sender multicasts RTC messages at 20 Hz to ${participantCount - 1} receivers through the default mesh topology.`,
                distributedRunId: `hetzner-rtc-messages-principal-${participantCount}-agent-30s-20hz-mesh`,
                recipes: principalRecipes,
                agentCount: participantCount,
                profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'mesh', 'extended'],
                live: true,
                targetAgentIds: controllerAgentIds(participantCount),
                targetPolicyMode: 'role-map',
                rolePattern: 'one-sender-many-receivers',
                barrier: true,
                metadata: multicastManifestMetadata({
                    topologyProfile: 'mesh',
                    ...principalMetadata,
                }),
            }),
            buildManifestEntry({
                filePath: allPeerTreePath,
                title: `RTC messages all-peer ${participantCount}-agent 30s 5 Hz tree`,
                description: `All ${participantCount} headless peers multicast RTC messages at 5 Hz through a forced tree topology.`,
                distributedRunId: `hetzner-rtc-messages-all-peer-${participantCount}-agent-30s-5hz-tree`,
                recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
                    participantCount,
                    durationSeconds: 30,
                    rateHz: 5,
                    minReceiveRatio: 0.9,
                    group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                    readyTimeoutMs: 45_000,
                    stream: {
                        maxP95SendDurationMs: 2_500,
                        maxP99SendDurationMs: 4_000,
                    },
                }),
                agentCount: participantCount,
                profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'extended'],
                live: true,
                barrier: true,
                metadata: multicastManifestMetadata({
                    topologyProfile: 'tree',
                    treeMeshMinSize: participantCount + 1,
                    participantCount,
                    senderCount: participantCount,
                    durationSeconds: 30,
                    rateHz: 5,
                    minReceiveRatio: 0.9,
                    receiverExpectedFrames: (participantCount - 1) * 30 * 5,
                    recommendedTerminalTimeoutSeconds: 330,
                }),
            }),
        ];
    });
}

function buildRtcMessagesMediumScaleMatrixEntries(): readonly HetznerDistributedManifestEntry[] {
    return RTC_MESSAGES_MATRIX_AGENT_COUNTS.flatMap(participantCount =>
        RTC_MESSAGES_MATRIX_DURATION_SECONDS.flatMap(durationSeconds =>
            RTC_MESSAGES_MATRIX_RATE_HZ.flatMap(rateHz =>
                RTC_MESSAGES_MATRIX_PROFILES.map(profile =>
                    buildRtcMessagesMatrixEntry({
                        profile,
                        participantCount,
                        durationSeconds,
                        rateHz,
                    })
                )
            )
        )
    );
}

function buildRtcMessagesMatrixEntry(input: Readonly<{
    profile: typeof RTC_MESSAGES_MATRIX_PROFILES[number];
    participantCount: number;
    durationSeconds: number;
    rateHz: number;
}>): HetznerDistributedManifestEntry {
    const label = durationLabel(input.durationSeconds);
    const minReceiveRatio = input.profile === 'principal'
        ? 0.95
        : input.rateHz === 20
            ? 0.8
            : 0.85;
    const senderCount = input.profile === 'principal' ? 1 : input.participantCount;
    const receiverExpectedFrames = input.profile === 'principal'
        ? input.durationSeconds * input.rateHz
        : (input.participantCount - 1) * input.durationSeconds * input.rateHz;
    const stream = streamOptionsForRtcMessagesMatrix(input.durationSeconds, input.rateHz);
    const baseInput = {
        participantCount: input.participantCount,
        durationSeconds: input.durationSeconds,
        rateHz: input.rateHz,
        minReceiveRatio,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        readyTimeoutMs: 45_000,
        stream,
    };
    const roleFields = input.profile === 'principal'
        ? {
              recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes(baseInput),
              targetAgentIds: controllerAgentIds(input.participantCount),
              targetPolicyMode: 'role-map' as const,
              rolePattern: 'one-sender-many-receivers' as const,
          }
        : {
              recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe(baseInput),
          };

    return buildManifestEntry({
        filePath:
            `apps/rallar-black-box/manifests/hetzner/diagnostic/matrix/rtc-messages-${input.profile}-${input.participantCount}-agent-${label}-${input.rateHz}hz-tree.json`,
        title:
            `RTC messages ${input.profile} ${input.participantCount}-agent ${label} ${input.rateHz} Hz tree diagnostic`,
        description:
            `Diagnostic ${input.participantCount}-agent ${input.profile} RTC messages multicast run at ${input.rateHz} Hz for ${label} through a forced tree topology.`,
        distributedRunId:
            `hetzner-diagnostic-rtc-messages-${input.profile}-${input.participantCount}-agent-${label}-${input.rateHz}hz-tree`,
        ...roleFields,
        agentCount: input.participantCount,
        profiles: ['rtc', 'messages.rtc', input.profile, 'multicast', 'tree', 'matrix', 'diagnostic'],
        live: true,
        diagnostic: true,
        stress: true,
        barrier: true,
        metadata: multicastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: input.participantCount,
            senderCount,
            durationSeconds: input.durationSeconds,
            rateHz: input.rateHz,
            minReceiveRatio,
            receiverExpectedFrames,
            recommendedTerminalTimeoutSeconds: input.durationSeconds + 300,
        }),
    });
}

function streamOptionsForRtcMessagesMatrix(
    durationSeconds: number,
    rateHz: number,
): RallarBlackBoxRtcMessagesMatrixStreamOptions {
    return {
        ...(durationSeconds >= 300
            ? {
                  progressEveryMs: 30_000,
                  sampleEvery: 100,
                  drainTimeoutMs: 30_000,
              }
            : {}),
        maxDroppedFrames: Math.ceil(durationSeconds * rateHz * 0.05),
        maxP95SendDurationMs: 2_500,
        maxP99SendDurationMs: 4_000,
    };
}

type RallarBlackBoxRtcMessagesMatrixStreamOptions = NonNullable<
    Parameters<typeof createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe>[0]
>['stream'];

function durationLabel(seconds: number): string {
    return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

function catalogItems(input: ManifestCatalogInput): readonly DistributedRecipeCatalogItem[] {
    const recipes = input.recipes ?? (input.recipe === undefined ? [] : [input.recipe]);
    if (recipes.length === 0) {
        throw new Error(`Manifest ${input.distributedRunId} must define at least one recipe.`);
    }
    return recipes.map((recipe, index) => catalogItem(input, recipe, index, recipes.length));
}

function catalogItem(
    input: ManifestCatalogInput,
    recipe: RallarBlackBoxTestRecipe,
    index: number,
    total: number,
): DistributedRecipeCatalogItem {
    return {
        itemId: total > 1 ? `${input.distributedRunId}:${recipe.recipeId}` : input.distributedRunId,
        title: total > 1 ? `${input.title} ${index + 1}` : input.title,
        description: recipe.description ?? input.description,
        recipe,
        providerMode: input.live ? 'browser-rallar' : 'simulated',
        profiles: input.profiles,
        prerequisites: input.live
            ? [
                  'connected browser control agents',
                  'matching Hetzner headless room',
                  'live Rallar backend',
              ]
            : ['connected browser control agents'],
        live: input.live,
        source: 'app-local',
    };
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
            maxP99SendDurationMs: 4000,
        },
    });

    const receiverSetup = sender.commands.filter(command =>
        command.kind === 'http.request' || command.kind === 'rtc.connect'
    );

    return [
        sender,
        {
            schemaVersion: 1,
            recipeId: 'rtc-realtime-stability-receiver',
            name: 'RTC realtime stability receiver hold',
            description: 'Connect RTC and keep the receiver alive while the 20 Hz sender stream runs.',
            continueOnFailure: false,
            metadata: {
                ...sender.metadata,
                profile: 'rtc-realtime-stability-receiver',
                role: 'receiver',
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
                            frameCount: 600,
                        },
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
                                    frameCount: 600,
                                },
                            },
                        },
                    ],
                },
            ],
        },
    ];
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
                label: 'Headless health',
            },
            {
                kind: 'stats',
                commandId: 'headless-stats',
            },
        ],
    };
}

function fixtureRecipe(fixtureId: string): RallarBlackBoxTestRecipe {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(candidate => candidate.fixtureId === fixtureId);
    if (!fixture) {
        throw new Error(`Unknown Rallar black-box recipe fixture: ${fixtureId}`);
    }
    return {
        schemaVersion: 1,
        ...fixture.recipe,
    };
}
