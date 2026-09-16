import type { DistributedRecipeCatalogItem } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import {
    buildDistributedRunManifest,
    type DistributedRecipeTargetPolicyMode
} from '@shared-test/rallar-bb-test/distributed-recipe-targeting/build-distributed-run-manifest.ts';
import type { DistributedRecipeRolePattern } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/distributed-recipe-role-pattern.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxDistributedGroupAssertion
} from '@shared-test/rallar-bb-test/distributed/group-assertions.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
export const HETZNER_DISTRIBUTED_MANIFEST_GROUP: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'hetzner-headless-room'
};

export const HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER = [
    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json'
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
    'apps/rallar-black-box/manifests/hetzner/16-rtc-absence-wait-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/17-group-assertions-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json',
    'apps/rallar-black-box/manifests/hetzner/20-alm-conformance-30-agent-30s.json',
    'apps/rallar-black-box/manifests/hetzner/21-alm-conformance-50-agent-30s.json'
] as const;

export interface HetznerDistributedManifestEntry {
    readonly filePath: string;
    readonly title: string;
    readonly description: string;
    readonly agentCount: number;
    readonly mainline: boolean;
    readonly diagnostic: boolean;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
}

export interface ManifestCatalogInput {
    readonly filePath: string;
    readonly title: string;
    readonly description: string;
    readonly distributedRunId: string;
    readonly recipe?: RallarBlackBoxTestRecipe;
    readonly recipes?: readonly RallarBlackBoxTestRecipe[];
    readonly agentCount: number;
    readonly profiles: readonly string[];
    readonly live: boolean;
    readonly targetAgentIds?: readonly string[];
    readonly targetPolicyMode?: DistributedRecipeTargetPolicyMode;
    readonly rolePattern?: DistributedRecipeRolePattern;
    readonly mainline?: boolean;
    readonly diagnostic?: boolean;
    readonly expectedFailure?: boolean;
    readonly stress?: boolean;
    readonly barrier?: boolean;
    readonly groupAssertions?: readonly RallarBlackBoxDistributedGroupAssertion[];
    readonly metadata?: Readonly<Record<string, unknown>>;
}

const DEFAULT_ACK_TIMEOUT_MS = 30_000;

const DEFAULT_CONTROL_RUN_ID = 'hetzner-manifest-template-control-run';

export function createManifestEntry(input: ManifestCatalogInput): HetznerDistributedManifestEntry {
    const manifest = buildDistributedRunManifest({
        distributedRunId: input.distributedRunId,
        controlRunId: DEFAULT_CONTROL_RUN_ID,
        displayName: input.title,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        recipes: toCatalogItems(input),
        targetAgentIds: input.targetAgentIds ?? [],
        targetPolicyMode: input.targetPolicyMode ?? 'all-online-group-members',
        rolePattern: input.rolePattern ?? 'all-agents',
        ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
        barrier: input.barrier || (input.live && input.agentCount >= 2)
            ? {
                enabled: true,
                timeoutMs: 15_000
            }
            : { enabled: false },
        startMode: 'manual',
        expectedParticipantCount: input.agentCount,
        groupAssertions: input.groupAssertions ?? []
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
                ...(input.metadata ?? {})
            }
        }
    };
}

export function toControllerAgentIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_value, index) => `controller-${String(index + 1).padStart(2, '0')}`);
}

export function toMulticastManifestMetadata(
    input: Readonly<{
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
    }>
): Readonly<Record<string, unknown>> {
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
                : '16'
        },
        receiverDelivery: {
            expectedInboundMessages: input.receiverExpectedFrames,
            minExpectedInboundMessages: Math.floor(input.receiverExpectedFrames * input.minReceiveRatio),
            minReceiveRatio: input.minReceiveRatio
        },
        loadEstimate: {
            streamFrames,
            logicalFanoutMessages: streamFrames * (input.participantCount - 1)
        }
    };
}

function toCatalogItems(input: ManifestCatalogInput): readonly DistributedRecipeCatalogItem[] {
    const recipes = input.recipes ?? (input.recipe === undefined ? [] : [input.recipe]);
    if (recipes.length === 0) {
        throw new Error(`Manifest ${input.distributedRunId} must define at least one recipe.`);
    }
    return recipes.map((recipe, index) =>
        toCatalogItem({ input: input, recipe: recipe, index: index, total: recipes.length })
    );
}

function toCatalogItem(selection: ManifestRecipeSelection): DistributedRecipeCatalogItem {
    const { input, recipe, index, total } = selection;
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
                'live Rallar backend'
            ]
            : ['connected browser control agents'],
        live: input.live,
        source: 'app-local'
    };
}

interface ManifestRecipeSelection {
    readonly input: ManifestCatalogInput;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly index: number;
    readonly total: number;
}
