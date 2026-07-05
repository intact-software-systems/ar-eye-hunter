import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import {
    buildDistributedRunManifest,
    type DistributedRecipeCatalogItem,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcRealtimeStabilityRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';

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
    'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json',
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
    recipe: RallarBlackBoxTestRecipe;
    agentCount: number;
    profiles: readonly string[];
    live: boolean;
    mainline?: boolean;
    diagnostic?: boolean;
    expectedFailure?: boolean;
    stress?: boolean;
    barrier?: boolean;
}>;

const DEFAULT_ACK_TIMEOUT_MS = 30_000;
const DEFAULT_CONTROL_RUN_ID = 'hetzner-manifest-template-control-run';

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
            recipe: withoutDemoCredentials(createRallarBlackBoxProviderParityLiveRecipe({
                group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
                readyPeerCount: 1,
                readyTimeoutMs: 10_000,
            })),
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
    ];
}

function buildManifestEntry(input: ManifestCatalogInput): HetznerDistributedManifestEntry {
    const manifest = buildDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: DEFAULT_CONTROL_RUN_ID,
        displayName: input.title,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        recipes: [catalogItem(input)],
        targetAgentIds: [],
        targetPolicyMode: 'all-online-group-members',
        rolePattern: 'all-agents',
        ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
        barrier: input.barrier
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
            },
        },
    };
}

function catalogItem(input: ManifestCatalogInput): DistributedRecipeCatalogItem {
    return {
        itemId: input.distributedRunId,
        title: input.title,
        description: input.description,
        recipe: input.recipe,
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

function withoutDemoCredentials(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    const copy = structuredClone(recipe) as RallarBlackBoxTestRecipe;
    for (const command of copy.commands) {
        if (command.kind !== 'configure') {
            continue;
        }
        const config = command.config as unknown;
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            continue;
        }
        const rallar = (config as { rallar?: unknown }).rallar;
        if (!rallar || typeof rallar !== 'object' || Array.isArray(rallar)) {
            continue;
        }
        delete (rallar as { username?: unknown }).username;
        delete (rallar as { password?: unknown }).password;
        delete (rallar as { token?: unknown }).token;
        delete (rallar as { restoreSession?: unknown }).restoreSession;
    }
    return copy;
}
