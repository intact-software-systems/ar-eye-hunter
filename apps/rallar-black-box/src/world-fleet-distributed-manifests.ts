import {
    buildDistributedRunManifest,
    type DistributedRecipeCatalogItem,
    type DistributedRecipeRolePattern
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';

export const WORLD_FLEET_DISTRIBUTED_MANIFEST_GROUP: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'world-fleet-room'
};

export const WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER = [
    'apps/rallar-black-box/manifests/world-fleet/01-rtc-messages-principal-50-agent-30s-20hz-tree.json',
    'apps/rallar-black-box/manifests/world-fleet/02-rtc-messages-principal-50-agent-30s-20hz-mesh.json',
    'apps/rallar-black-box/manifests/world-fleet/03-rtc-messages-all-peer-50-agent-30s-5hz-tree.json'
] as const;

export const WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER = [
    'apps/rallar-black-box/manifests/world-fleet/diagnostic/rtc-messages-all-peer-50-agent-30s-20hz-tree.json',
    'apps/rallar-black-box/manifests/world-fleet/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json',
    'apps/rallar-black-box/manifests/world-fleet/diagnostic/rtc-messages-all-peer-50-agent-60m-5hz-tree.json',
    'apps/rallar-black-box/manifests/world-fleet/diagnostic/rtc-messages-all-peer-50-agent-60m-10hz-tree.json',
    'apps/rallar-black-box/manifests/world-fleet/diagnostic/rtc-messages-all-peer-50-agent-60m-20hz-tree.json'
] as const;

export type WorldFleetDistributedManifestEntry = Readonly<{
    filePath: string;
    title: string;
    description: string;
    agentCount: number;
    mainline: boolean;
    diagnostic: boolean;
    manifest: RallarBlackBoxDistributedRunManifest;
}>;

type WorldFleetManifestInput = Readonly<{
    filePath: string;
    title: string;
    description: string;
    distributedRunId: string;
    recipe?: RallarBlackBoxTestRecipe;
    recipes?: readonly RallarBlackBoxTestRecipe[];
    profiles: readonly string[];
    rolePattern: DistributedRecipeRolePattern;
    diagnostic?: boolean;
    metadata: Readonly<Record<string, unknown>>;
}>;

const WORLD_FLEET_AGENT_COUNT = 50;
const DEFAULT_CONTROL_RUN_ID = 'world-fleet-template-control-run';
const DEFAULT_ACK_TIMEOUT_MS = 45_000;

export function buildWorldFleetDistributedManifestCatalog(): readonly WorldFleetDistributedManifestEntry[] {
    return [
        principalEntry({
            filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER[0],
            topologyProfile: 'tree',
            diagnostic: false
        }),
        principalEntry({
            filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER[1],
            topologyProfile: 'mesh',
            diagnostic: false
        }),
        allPeerEntry({
            filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_GREEN_ORDER[2],
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            receiverExpectedFrames: 7_350,
            diagnostic: false
        }),
        allPeerEntry({
            filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER[0],
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.8,
            receiverExpectedFrames: 29_400,
            diagnostic: true
        }),
        principalEntry({
            filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER[1],
            topologyProfile: 'tree',
            durationSeconds: 3_600,
            diagnostic: true
        }),
        ...[5, 10, 20].map((rateHz, index) =>
            allPeerEntry({
                filePath: WORLD_FLEET_DISTRIBUTED_MANIFEST_DIAGNOSTIC_ORDER[index + 2],
                durationSeconds: 3_600,
                rateHz,
                minReceiveRatio: rateHz === 20 ? 0.8 : rateHz === 10 ? 0.85 : 0.9,
                receiverExpectedFrames: 49 * 3_600 * rateHz,
                diagnostic: true
            })
        )
    ];
}

function principalEntry(
    input: Readonly<{
        filePath: string;
        topologyProfile: 'tree' | 'mesh';
        durationSeconds?: number;
        diagnostic: boolean;
    }>
): WorldFleetDistributedManifestEntry {
    const durationSeconds = input.durationSeconds ?? 30;
    const long = durationSeconds >= 3_600;
    const runIdSuffix = long
        ? `60m-20hz-${input.topologyProfile}`
        : `30s-20hz-${input.topologyProfile}`;
    return buildWorldFleetManifestEntry({
        filePath: input.filePath,
        title: `RTC messages principal 50-agent ${long ? '60m' : '30s'} 20 Hz ${input.topologyProfile}${
            input.diagnostic ? ' diagnostic' : ''
        }`,
        description:
            `Already-running world fleet: first resolved agent multicasts RTC messages at 20 Hz to 49 receivers through ${input.topologyProfile} topology.`,
        distributedRunId: `${
            input.diagnostic ? 'world-fleet-diagnostic' : 'world-fleet'
        }-rtc-messages-principal-50-agent-${runIdSuffix}`,
        recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: WORLD_FLEET_AGENT_COUNT,
            durationSeconds,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: WORLD_FLEET_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
            stream: long
                ? {
                    progressEveryMs: 30_000,
                    sampleEvery: 100,
                    drainTimeoutMs: 30_000,
                    maxDroppedFrames: 3_600,
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000
                }
                : {
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000
                }
        }),
        profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', input.topologyProfile, long ? 'long' : 'short'],
        rolePattern: 'one-sender-many-receivers',
        diagnostic: input.diagnostic,
        metadata: multicastMetadata({
            topologyProfile: input.topologyProfile,
            senderCount: 1,
            durationSeconds,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: durationSeconds * 20,
            recommendedTerminalTimeoutSeconds: long ? 3_900 : 330
        })
    });
}

function allPeerEntry(
    input: Readonly<{
        filePath: string;
        durationSeconds: number;
        rateHz: number;
        minReceiveRatio: number;
        receiverExpectedFrames: number;
        diagnostic: boolean;
    }>
): WorldFleetDistributedManifestEntry {
    const long = input.durationSeconds >= 3_600;
    const label = long ? '60m' : '30s';
    return buildWorldFleetManifestEntry({
        filePath: input.filePath,
        title: `RTC messages all-peer 50-agent ${label} ${input.rateHz} Hz tree${
            input.diagnostic ? ' diagnostic' : ''
        }`,
        description:
            `Already-running world fleet: all 50 resolved agents multicast RTC messages at ${input.rateHz} Hz through forced tree topology.`,
        distributedRunId: `${
            input.diagnostic ? 'world-fleet-diagnostic' : 'world-fleet'
        }-rtc-messages-all-peer-50-agent-${label}-${input.rateHz}hz-tree`,
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: WORLD_FLEET_AGENT_COUNT,
            durationSeconds: input.durationSeconds,
            rateHz: input.rateHz,
            minReceiveRatio: input.minReceiveRatio,
            group: WORLD_FLEET_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
            stream: long
                ? {
                    progressEveryMs: 30_000,
                    sampleEvery: 100,
                    drainTimeoutMs: 30_000,
                    maxDroppedFrames: Math.ceil(input.durationSeconds * input.rateHz * 0.05),
                    maxP95SendDurationMs: 2_500,
                    maxP99SendDurationMs: 4_000
                }
                : undefined
        }),
        profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', long ? 'long' : 'short'],
        rolePattern: 'all-agents',
        diagnostic: input.diagnostic,
        metadata: multicastMetadata({
            topologyProfile: 'tree',
            senderCount: WORLD_FLEET_AGENT_COUNT,
            durationSeconds: input.durationSeconds,
            rateHz: input.rateHz,
            minReceiveRatio: input.minReceiveRatio,
            receiverExpectedFrames: input.receiverExpectedFrames,
            recommendedTerminalTimeoutSeconds: long ? 4_200 : 330
        })
    });
}

function buildWorldFleetManifestEntry(input: WorldFleetManifestInput): WorldFleetDistributedManifestEntry {
    const recipes = input.recipes ?? (input.recipe ? [input.recipe] : []);
    const manifest = buildDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: DEFAULT_CONTROL_RUN_ID,
        displayName: input.title,
        group: WORLD_FLEET_DISTRIBUTED_MANIFEST_GROUP,
        recipes: recipes.map((recipe) => recipeCatalogItem(recipe, input.profiles)),
        targetAgentIds: [],
        targetPolicyMode: 'all-online-group-members',
        rolePattern: input.rolePattern,
        ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
        barrier: { enabled: true, timeoutMs: DEFAULT_ACK_TIMEOUT_MS },
        startMode: 'manual',
        expectedParticipantCount: WORLD_FLEET_AGENT_COUNT
    });

    return {
        filePath: input.filePath,
        title: input.title,
        description: input.description,
        agentCount: WORLD_FLEET_AGENT_COUNT,
        mainline: !input.diagnostic,
        diagnostic: input.diagnostic === true,
        manifest: {
            ...manifest,
            metadata: {
                ...manifest.metadata,
                ...input.metadata,
                worldFleet: true,
                noSpawn: true
            }
        }
    };
}

function recipeCatalogItem(
    recipe: RallarBlackBoxTestRecipe,
    profiles: readonly string[]
): DistributedRecipeCatalogItem {
    return {
        itemId: recipe.recipeId,
        title: recipe.name ?? recipe.recipeId,
        description: recipe.description ?? recipe.recipeId,
        recipe,
        providerMode: 'browser-rallar',
        profiles,
        prerequisites: ['already-running world-fleet headless agents'],
        live: true,
        source: 'app-local'
    };
}

function multicastMetadata(
    input: Readonly<{
        topologyProfile: 'tree' | 'mesh';
        senderCount: number;
        durationSeconds: number;
        rateHz: number;
        minReceiveRatio: number;
        receiverExpectedFrames: number;
        recommendedTerminalTimeoutSeconds: number;
    }>
): Readonly<Record<string, unknown>> {
    const streamFrames = input.durationSeconds * input.rateHz * input.senderCount;
    return {
        topologyProfile: input.topologyProfile,
        transport: 'messages.rtc',
        participantCount: WORLD_FLEET_AGENT_COUNT,
        senderCount: input.senderCount,
        receiverCount: input.senderCount === WORLD_FLEET_AGENT_COUNT
            ? WORLD_FLEET_AGENT_COUNT
            : WORLD_FLEET_AGENT_COUNT - input.senderCount,
        rateHz: input.rateHz,
        expectedDurationSeconds: input.durationSeconds,
        recommendedTerminalTimeoutSeconds: input.recommendedTerminalTimeoutSeconds,
        rtcTopologyEnv: {
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: input.topologyProfile === 'tree' ? '51' : '16'
        },
        receiverDelivery: {
            expectedInboundMessages: input.receiverExpectedFrames,
            minExpectedInboundMessages: Math.floor(input.receiverExpectedFrames * input.minReceiveRatio),
            minReceiveRatio: input.minReceiveRatio
        },
        loadEstimate: {
            streamFrames,
            logicalFanoutMessages: streamFrames * (WORLD_FLEET_AGENT_COUNT - 1)
        }
    };
}
