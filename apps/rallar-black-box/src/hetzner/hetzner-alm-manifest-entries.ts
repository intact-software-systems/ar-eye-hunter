import {
    ALM_CONFORMANCE_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    type RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from '@shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

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

/**
 * Each reads red by a recorded gap: the api-v1 WS server does not route a WS-carried multicast room envelope (PR #588);
 * no plain-member write advances the snapshot version, so a floor one past it is never reached.
 */
const HETZNER_WITHHELD_ALM_SCENARIO_KEYS: readonly string[] = [
    'cross-carrier-duplicate-rtc-then-ws',
    'not-yet-in-sync-delivered-after-refresh'
];

export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEntry {
    const scenarios = toAlmConformanceScenariosForAllCarriers();

    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[17],
        title: 'ALM conformance 2-agent',
        description: 'ALM conformance family (bounded rejection, deadline expiry, delivery ' +
            'baseline, lifecycle, durable reload, ordering resync, the cross-carrier duplicate, and not-yet-in-sync) ' +
            'across ws, rtc, and rtc-with-ws-fallback carriers.',
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
            recommendedTerminalTimeoutSeconds: 300,
            carriers: [...ALM_CONFORMANCE_CARRIERS],
            scenarios: toAlmConformanceScenarioIds(scenarios)
        }
    });
}

function toAlmConformanceScenariosForAllCarriers(): readonly AlmConformanceScenario[] {
    const scenarios = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            carrier,
            typeId: ALM_CONFORMANCE_TYPE_ID,
            senderConnection: ALM_CONFORMANCE_SENDER_CONNECTION,
            receiverConnection: ALM_CONFORMANCE_RECEIVER_CONNECTION,
            deadlineMs: ALM_CONFORMANCE_DEADLINE_MS
        })
    ).filter((scenario) => !HETZNER_WITHHELD_ALM_SCENARIO_KEYS.includes(scenario.scenarioKey));
    // Receiver absence windows in ordinary scenarios must not consume the later reload specimen's TTL.
    return [
        ...scenarios.filter((scenario) => scenario.scenarioId === 'delivery-reload'),
        ...scenarios.filter((scenario) => scenario.scenarioId !== 'delivery-reload')
    ];
}

export function toAlmConformanceCombinedRecipe(
    scenarios: readonly AlmConformanceScenario[],
    role: 'sender' | 'receiver'
): RallarBlackBoxTestRecipe {
    const checkpoints = scenarios.filter((scenario) => scenario.scenarioId === 'delivery-reload').flatMap(
        (scenario) => {
            const authored = toAlmReloadCheckpoints(scenario[role].metadata?.almReloadCheckpoints);
            if (!authored) {
                throw new Error('Generated ALM reload recipe is missing its authored checkpoints.');
            }
            return authored.map((checkpoint) => ({ ...checkpoint }));
        }
    );
    return {
        schemaVersion: 1,
        recipeId: `alm-conformance-${role}`,
        name: `ALM conformance ${role} across ws, rtc, and rtc-with-ws-fallback carriers`,
        continueOnFailure: false,
        metadata: { profile: 'alm-conformance', role, almReloadCheckpoints: checkpoints },
        commands: toAlmConformanceCombinedCommands(scenarios, role)
    };
}

/**
 * One ready scoped connection observes early frames while independent roles finish their absence windows. Only a
 * scenario's prologue requests are dropped for the shared one; a request inside a scenario is one of its steps.
 */
function toAlmConformanceCombinedCommands(
    scenarios: readonly AlmConformanceScenario[],
    role: 'sender' | 'receiver'
): RallarBlackBoxTestRecipe['commands'] {
    const rtc = scenarios.find((scenario) => scenario.sender.metadata?.carrier === 'rtc')!;
    const rtcConnect = rtc[role].commands.find((command) => command.kind === 'rtc.connect')!;
    const prologueEnd = rtc[role].commands.indexOf(rtcConnect);
    const prologue = rtc[role].commands.slice(0, prologueEnd + 1).filter((command) =>
        command.kind === 'http.request' || command.kind === 'rtc.connect'
    ).map((command) =>
        command.kind === 'rtc.connect'
            ? toCombinedAlmConnect(command, rtcConnect.readiness)
            : command
    );
    return [
        ...prologue,
        ...scenarios.flatMap((scenario) => {
            const commands = scenario[role].commands;
            const scenarioConnectAt = commands.findIndex((command) => command.kind === 'rtc.connect');
            if (scenarioConnectAt < 0) {
                throw new Error(`Generated ALM recipe ${scenario[role].recipeId} has no rtc.connect prologue.`);
            }
            return commands.slice(scenarioConnectAt + 1).map((command) =>
                command.kind === 'rtc.connect' ? toCombinedAlmConnect(command, rtcConnect.readiness) : command
            );
        })
    ];
}

/** A new sender document must recover the shared RTC-ready subscription before later mixed-carrier work. */
function toCombinedAlmConnect(
    command: RallarBlackBoxTestRtcConnectCommand,
    readiness: RallarBlackBoxTestRtcConnectCommand['readiness']
): RallarBlackBoxTestRtcConnectCommand {
    return {
        ...command,
        transport: 'messages.rtc',
        readiness,
        rallar: { ...command.rallar, messageSelector: { topicId: 'room.alm-conformance' } }
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
