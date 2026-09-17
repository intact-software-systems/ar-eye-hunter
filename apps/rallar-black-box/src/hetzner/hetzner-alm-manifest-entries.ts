import {
    ALM_CONFORMANCE_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    type RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from '@shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { HetznerDistributedManifestEntry } from './hetzner-manifest-entry.ts';
import {
    createManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    toControllerAgentIds,
    toMulticastManifestMetadata
} from './hetzner-manifest-entry.ts';

const ALM_CONFORMANCE_TYPE_ID = 'alm.conformance';

const ALM_CONFORMANCE_DEADLINE_MS = 18_000;

const ALM_CONFORMANCE_SENDER_CONNECTION = 'almConformanceSender';

const ALM_CONFORMANCE_RECEIVER_CONNECTION = 'almConformanceReceiver';

const ALM_CONFORMANCE_EXTENDED_AGENT_COUNTS = [15, 30, 50] as const;

export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEntry {
    const scenarios = toAlmConformanceScenariosForAllCarriers();

    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[17],
        title: 'ALM conformance 2-agent',
        description: 'ALM conformance family (bounded rejection, deadline expiry, delivery ' +
            'baseline, and ordering resync) across ws, rtc, and rtc-with-ws-fallback carriers.',
        distributedRunId: 'hetzner-alm-conformance-2-agent',
        recipes: [
            toAlmConformanceCombinedRecipe(scenarios, 'sender'),
            toAlmConformanceCombinedRecipe(scenarios, 'receiver')
        ],
        agentCount: 2,
        profiles: ['alm', 'conformance', '2-agent', 'github-free-smoke', 'extended'],
        live: true,
        targetAgentIds: ['controller-01', 'controller-02'],
        targetPolicyMode: 'role-map',
        rolePattern: 'sender-receiver',
        mainline: false,
        diagnostic: false,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: [],
        metadata: {
            family: 'alm-conformance',
            carriers: [...ALM_CONFORMANCE_CARRIERS],
            scenarios: toAlmConformanceScenarioIds(scenarios)
        }
    });
}

function toAlmConformanceScenariosForAllCarriers(): readonly AlmConformanceScenario[] {
    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            carrier,
            typeId: ALM_CONFORMANCE_TYPE_ID,
            senderConnection: ALM_CONFORMANCE_SENDER_CONNECTION,
            receiverConnection: ALM_CONFORMANCE_RECEIVER_CONNECTION,
            deadlineMs: ALM_CONFORMANCE_DEADLINE_MS
        })
    );
}

function toAlmConformanceCombinedRecipe(
    scenarios: readonly AlmConformanceScenario[],
    role: 'sender' | 'receiver'
): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: `alm-conformance-${role}`,
        name: `ALM conformance ${role} across ws, rtc, and rtc-with-ws-fallback carriers`,
        continueOnFailure: false,
        metadata: { profile: 'alm-conformance', role },
        commands: scenarios.flatMap((scenario) => scenario[role].commands)
    };
}

function toAlmConformanceScenarioIds(
    scenarios: readonly AlmConformanceScenario[]
): readonly string[] {
    return [...new Set(scenarios.map((scenario) => scenario.scenarioId))];
}

export function createAlmConformanceExtendedEntries(): readonly HetznerDistributedManifestEntry[] {
    return ALM_CONFORMANCE_EXTENDED_AGENT_COUNTS.map((participantCount, index) =>
        createAlmConformanceExtendedEntry({
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[18 + index]!,
            participantCount
        })
    );
}

function createAlmConformanceExtendedEntry(
    input: Readonly<{ filePath: string; participantCount: number; }>
): HetznerDistributedManifestEntry {
    const [sender, receiver] = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes(
        toAlmConformanceExtendedRecipeOptions(input.participantCount)
    );

    return createManifestEntry({
        filePath: input.filePath,
        title: `ALM conformance ${input.participantCount}-agent 30s`,
        description: 'Layers an ALM storage-counters read onto a principal RTC messages ' +
            `multicast tree run for ALM delivery-metric evidence at ${input.participantCount} agents.`,
        distributedRunId: `hetzner-alm-conformance-${input.participantCount}-agent-30s`,
        recipes: [
            toRecipeWithStorageCounters(sender, 'sender'),
            toRecipeWithStorageCounters(receiver, 'receiver')
        ],
        agentCount: input.participantCount,
        profiles: toAlmConformanceExtendedProfiles(input.participantCount),
        live: true,
        targetAgentIds: toControllerAgentIds(input.participantCount),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        mainline: false,
        diagnostic: false,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: [],
        metadata: toAlmConformanceExtendedMetadata(input.participantCount)
    });
}

function toAlmConformanceExtendedRecipeOptions(
    participantCount: number
): RallarBlackBoxRtcMessagesMulticastRecipeOptions {
    return {
        participantCount,
        durationSeconds: 30,
        rateHz: 20,
        minReceiveRatio: 0.95,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        readyTimeoutMs: 45_000,
        stream: {
            maxP95SendDurationMs: 2_500,
            maxP99SendDurationMs: 4_000
        }
    };
}

function toAlmConformanceExtendedProfiles(participantCount: number): readonly string[] {
    return ['alm', 'messages.rtc', 'multicast', 'tree', `${participantCount}-agent`, 'extended'];
}

function toAlmConformanceExtendedMetadata(
    participantCount: number
): ReturnType<typeof toMulticastManifestMetadata> {
    return toMulticastManifestMetadata({
        topologyProfile: 'tree',
        treeMeshMinSize: participantCount + 1,
        participantCount,
        senderCount: 1,
        durationSeconds: 30,
        rateHz: 20,
        minReceiveRatio: 0.95,
        receiverExpectedFrames: 600,
        recommendedTerminalTimeoutSeconds: 330,
        catalogProfiles: []
    });
}

function toRecipeWithStorageCounters(
    recipe: RallarBlackBoxTestRecipe,
    role: 'sender' | 'receiver'
): RallarBlackBoxTestRecipe {
    return {
        ...recipe,
        commands: [
            ...recipe.commands,
            {
                kind: 'storage.counters',
                commandId: `alm-storage-counters-${role}`,
                reset: false,
                timeoutMs: 5_000
            }
        ]
    };
}
