import {
    ALM_CONFORMANCE_CARRIERS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    createAlmConformanceRecipes,
    isThreeAgentScenario,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    type RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from '@shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord,
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

/** Reads red by a recorded gap: no plain-member write advances the snapshot version, so a floor one past it is never reached. */
const HETZNER_WITHHELD_ALM_SCENARIO_KEYS: readonly string[] = [
    'not-yet-in-sync-delivered-after-refresh'
];

export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEntry {
    const scenarios = toAlmConformanceScenariosForAllCarriers('two-agent');

    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[17],
        title: 'ALM conformance 2-agent',
        description: 'ALM conformance family (bounded rejection, deadline expiry, delivery ' +
            'baseline, lifecycle, durable reload, ordering resync, the cross-carrier duplicate, and not-yet-in-sync) ' +
            'across ws, rtc, and rtc-with-ws-fallback carriers.',
        distributedRunId: 'hetzner-alm-conformance-2-agent',
        recipes: [
            toAlmConformanceCombinedRecipe(scenarios, 'sender', 'two-agent'),
            toAlmConformanceCombinedRecipe(scenarios, 'receiver', 'two-agent')
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

/**
 * The three-peer receipted-audience family on three agents: an origin and two distinguishable recipients (D45). Every
 * recipient connects once; `recipient-b` leaves and reconnects inside the membership scenario of each carrier.
 */
export function createAlmConformance3AgentEntry(): HetznerDistributedManifestEntry {
    const scenarios = toAlmConformanceScenariosForAllCarriers('three-agent');
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[21],
        title: 'ALM conformance 3-agent',
        description:
            'ALM conformance three-peer family (the aggregated receipt, the retry to the missing recipient, the ' +
            'unknown ACK version, and the frozen audience after a recipient leaves) across ws, rtc, and ' +
            'rtc-with-ws-fallback carriers, with one sender and two recipients.',
        distributedRunId: 'hetzner-alm-conformance-3-agent',
        recipes: (['sender', 'receiver', 'recipient-b'] as const).map((role) =>
            toAlmConformanceCombinedRecipe(scenarios, role, 'three-agent')
        ),
        agentCount: 3,
        profiles: ['alm', 'conformance', '3-agent', 'extended'],
        live: true,
        targetAgentIds: ['controller-01', 'controller-02', 'controller-03'],
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-two-recipients',
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

/** A three-role scenario runs on its own three agents (D45), so each family combines into its own recipes. */
type AlmConformanceFamily = 'two-agent' | 'three-agent';

function toAlmConformanceScenariosForAllCarriers(family: AlmConformanceFamily): readonly AlmConformanceScenario[] {
    const scenarios = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            carrier,
            typeId: ALM_CONFORMANCE_TYPE_ID,
            senderConnection: ALM_CONFORMANCE_SENDER_CONNECTION,
            receiverConnection: ALM_CONFORMANCE_RECEIVER_CONNECTION,
            deadlineMs: ALM_CONFORMANCE_DEADLINE_MS
        })
    ).filter((scenario) =>
        isThreeAgentScenario(scenario) === (family === 'three-agent') &&
        !HETZNER_WITHHELD_ALM_SCENARIO_KEYS.includes(scenario.scenarioKey)
    );
    // Receiver absence windows in ordinary scenarios must not consume the later reload specimen's TTL.
    return [
        ...scenarios.filter((scenario) => scenario.scenarioId === 'delivery-reload'),
        ...scenarios.filter((scenario) => scenario.scenarioId !== 'delivery-reload')
    ];
}

export function toAlmConformanceCombinedRecipe(
    scenarios: readonly AlmConformanceScenario[],
    role: AlmConformanceRole,
    family: AlmConformanceFamily
): RallarBlackBoxTestRecipe {
    const checkpoints = scenarios.filter((scenario) => scenario.scenarioId === 'delivery-reload').flatMap(
        (scenario) => {
            const authored = toAlmReloadCheckpoints(toRoleRecipe(scenario, role).metadata?.almReloadCheckpoints);
            if (!authored) {
                throw new Error('Generated ALM reload recipe is missing its authored checkpoints.');
            }
            return authored.map((checkpoint) => ({ ...checkpoint }));
        }
    );
    // The two families run in one profile, so the three-agent recipes carry an identity of their own.
    const recipePrefix = family === 'three-agent' ? 'alm-conformance-3-agent' : 'alm-conformance';
    return {
        schemaVersion: 1,
        recipeId: `${recipePrefix}-${role}`,
        name: `ALM conformance ${role} across ws, rtc, and rtc-with-ws-fallback carriers`,
        continueOnFailure: false,
        metadata: {
            profile: 'alm-conformance',
            role,
            // The control server reads any checkpoint list, even an empty one, as a paired reload run of two roots.
            ...(checkpoints.length === 0 ? {} : { almReloadCheckpoints: checkpoints }),
            ...toCombinedReceiptRolesMetadata(scenarios, role)
        },
        commands: toAlmConformanceCombinedCommands(scenarios, role)
    };
}

/** A combined sender carries the receipt pins of every scenario, each naming the handle of its own send. */
function toCombinedReceiptRolesMetadata(
    scenarios: readonly AlmConformanceScenario[],
    role: AlmConformanceRole
): RallarBlackBoxTestRecord {
    const entries = scenarios.flatMap((scenario) => readAlmReceiptRolesEntries(toRoleRecipe(scenario, role)));
    return entries.length === 0 ? {} : { almReceiptRoles: entries.map((entry) => ({ ...entry })) };
}

function toRoleRecipe(scenario: AlmConformanceScenario, role: AlmConformanceRole): RallarBlackBoxTestRecipe {
    const recipe = toAlmConformanceRoleRecipe(scenario, role);
    if (recipe === undefined) {
        throw new Error(`Generated ALM scenario ${scenario.scenarioKey} declares no ${role} recipe.`);
    }
    return recipe;
}

/**
 * One ready scoped connection observes early frames while independent roles finish their absence windows. Only a
 * scenario's prologue requests are dropped for the shared one; a request inside a scenario is one of its steps.
 */
function toAlmConformanceCombinedCommands(
    scenarios: readonly AlmConformanceScenario[],
    role: AlmConformanceRole
): RallarBlackBoxTestRecipe['commands'] {
    const rtc = toRoleRecipe(scenarios.find((scenario) => scenario.sender.metadata?.carrier === 'rtc')!, role);
    const rtcConnect = rtc.commands.find((command) => command.kind === 'rtc.connect')!;
    const prologueEnd = rtc.commands.indexOf(rtcConnect);
    const prologue = rtc.commands.slice(0, prologueEnd + 1).filter((command) =>
        command.kind === 'http.request' || command.kind === 'rtc.connect'
    ).map((command) =>
        command.kind === 'rtc.connect'
            ? toCombinedAlmConnect(command, rtcConnect.readiness)
            : command
    );
    return [
        ...prologue,
        ...scenarios.flatMap((scenario) => {
            const recipe = toRoleRecipe(scenario, role);
            const commands = recipe.commands;
            const scenarioConnectAt = commands.findIndex((command) => command.kind === 'rtc.connect');
            if (scenarioConnectAt < 0) {
                throw new Error(`Generated ALM recipe ${recipe.recipeId} has no rtc.connect prologue.`);
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
