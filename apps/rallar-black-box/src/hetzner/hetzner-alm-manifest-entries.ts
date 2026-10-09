import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import {
    createAlmConformanceRecipes,
    toAlmConformanceRoleRecipe,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { claimExpiresReclaims } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/claim/claim-expires-reclaims.ts';
import { claimFirstWins } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/claim/claim-first-wins.ts';
import { claimRefusedOnRtc } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/claim/claim-refused-on-rtc.ts';
import { backpressureDeferred } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/congestion/backpressure-deferred.ts';
import { backpressureHandsOver } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/congestion/backpressure-hands-over.ts';
import { backpressureRefused } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/congestion/backpressure-refused.ts';
import { leaderConfirms } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/leader-ack/leader-confirms.ts';
import { leaderOutsideList } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/leader-ack/leader-outside-list.ts';
import { noLeaderRefused } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/leader-ack/no-leader-refused.ts';
import { fencedRejection } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/membership-fence/fenced-rejection.ts';
import { capacityAge } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/volatile-bound/capacity-age.ts';
import { capacityTracks } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/volatile-bound/capacity-tracks.ts';
import {
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    type RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from '@shared-test/rallar-bb-test/fixtures/rtc-multicast-recipes.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestCommand,
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

/** Also the execution budget of each combined root (distributed-run-commands.ts), so it bounds the whole hosted run. */
const ALM_CONFORMANCE_2_AGENT_TERMINAL_TIMEOUT_SECONDS = 1_800;

const ALM_CONFORMANCE_SENDER_CONNECTION = 'almConformanceSender';

const ALM_CONFORMANCE_RECEIVER_CONNECTION = 'almConformanceReceiver';

const ALM_CONFORMANCE_EXTENDED_AGENT_COUNTS = [15, 30, 50] as const;

/** Long enough for the slowest role to finish the windows of the previous scenario while the others wait (D62). */
export const ALM_COMBINED_SCENARIO_BARRIER_TIMEOUT_MS = 60_000;

interface HetznerWithheldAlmScenario {
    readonly scenarioKey: string;
    readonly carriers: readonly AlmConformanceCarrier[];
}

const HETZNER_WITHHELD_ALM_SCENARIOS: readonly HetznerWithheldAlmScenario[] = [
    // The checkpoint tier's lane evidence is local and the hosted full read's; manifest 18 keeps its recorded cells.
    { scenarioKey: 'checkpoint-recovery', carriers: ALM_CONFORMANCE_CARRIERS },
    { scenarioKey: 'checkpoint-lag', carriers: ALM_CONFORMANCE_CARRIERS },
    // The range repair cells' lane evidence is local and the hosted full read's too; manifest 18 stays as recorded.
    { scenarioKey: 'ordering-gap-repair', carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS },
    { scenarioKey: 'repair-exhausted', carriers: ALM_CONFORMANCE_CARRIERS },
    // The membership fence cells' lane evidence is local and the hosted full read's; manifest 22 stays as recorded.
    { scenarioKey: 'fenced-delivery', carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS },
    // A combined recipe keeps only its first prologue, so the recipient that leaves here would miss every later cell.
    { scenarioKey: 'fenced-catch-up', carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS },
    // The same for the sender, which leaves before it sends.
    { scenarioKey: 'fenced-rejection', carriers: fencedRejection.carriers },
    // The leader cells' lane evidence is local and the hosted full read's; manifest 22 stays as recorded.
    { scenarioKey: 'leader-confirms', carriers: leaderConfirms.carriers },
    { scenarioKey: 'no-leader-refused', carriers: noLeaderRefused.carriers },
    { scenarioKey: 'leader-outside-list', carriers: leaderOutsideList.carriers },
    // The claim cells' lane evidence is local and the hosted full read's; manifest 22 stays as recorded.
    { scenarioKey: 'claim-first-wins', carriers: claimFirstWins.carriers },
    { scenarioKey: 'claim-expires-reclaims', carriers: claimExpiresReclaims.carriers },
    { scenarioKey: 'claim-refused-on-rtc', carriers: claimRefusedOnRtc.carriers },
    // The age and track bound cells' lane evidence is local and the hosted full read's; manifest 18 stays as recorded.
    { scenarioKey: 'capacity-age', carriers: capacityAge.carriers },
    { scenarioKey: 'capacity-tracks', carriers: capacityTracks.carriers },
    // The congestion cells' lane evidence is local and the hosted full read's; manifest 18 stays as recorded.
    { scenarioKey: 'backpressure-hands-over', carriers: backpressureHandsOver.carriers },
    { scenarioKey: 'backpressure-refused', carriers: backpressureRefused.carriers },
    { scenarioKey: 'backpressure-deferred', carriers: backpressureDeferred.carriers }
];

export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEntry {
    const scenarios = toAlmConformanceScenariosForAllCarriers('two-agent');

    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[17],
        title: 'ALM conformance 2-agent',
        description: 'ALM conformance family (the volatile default, bounded rejection, deadline expiry, delivery ' +
            'baseline, lifecycle, the durable opt-in, durable reload, ordering resync, the cross-carrier duplicate, ' +
            'not-yet-in-sync, fallback within the deadline: a dropped RTC leg, a spent RTC receipt, and no ' +
            'fallback after the deadline, and the addressed sends: a command to the receiver, its unicast ' +
            'fallback, a command to the server, and the volatile session bound, and storage unavailable: a ' +
            'durable send refused typed and one downgraded to volatile) across ws, rtc, and rtc-with-ws-fallback ' +
            'carriers.',
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
            recommendedTerminalTimeoutSeconds: ALM_CONFORMANCE_2_AGENT_TERMINAL_TIMEOUT_SECONDS,
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

/** A three-role scenario runs on its own three agents, so each hosted entry combines into its own recipes. */
type AlmConformanceFamily = 'two-agent' | 'three-agent';

/**
 * The lane families each hosted entry carries. The addressed sends ride the 2-agent entry; a same-context scenario
 * needs two pages of one browser context, which no hosted agent has, so no entry carries it. The same-principal
 * audience cells are withheld as the membership fence cells are: their lane evidence is local and the hosted full
 * read's, so manifests 18 and 22 stay as recorded.
 */
const HOSTED_ALM_LANE_FAMILIES: Readonly<Record<AlmConformanceFamily, readonly AlmConformanceLaneFamily[]>> = {
    'two-agent': ['two-agent', 'addressed'],
    'three-agent': ['three-agent']
};

function toAlmConformanceScenariosForAllCarriers(family: AlmConformanceFamily): readonly AlmConformanceScenario[] {
    const scenarios = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
        createAlmConformanceRecipes({
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            carrier,
            typeId: ALM_CONFORMANCE_TYPE_ID,
            senderConnection: ALM_CONFORMANCE_SENDER_CONNECTION,
            receiverConnection: ALM_CONFORMANCE_RECEIVER_CONNECTION,
            deadlineMs: ALM_CONFORMANCE_DEADLINE_MS
        }).filter((scenario) => !isHetznerWithheldAlmScenario(scenario.scenarioKey, carrier))
    ).filter((scenario) => HOSTED_ALM_LANE_FAMILIES[family].includes(scenario.laneFamily));
    // Receiver absence windows in ordinary scenarios must not consume the later reload specimen's TTL, and a
    // capacity block closes and reconnects its sender, so nothing but another capacity block follows it.
    const isHoisted = (scenario: AlmConformanceScenario) =>
        scenario.scenarioId === 'delivery-reload' || scenario.scenarioId === 'capacity';
    return [
        ...scenarios.filter((scenario) => scenario.scenarioId === 'delivery-reload'),
        ...scenarios.filter((scenario) => !isHoisted(scenario)),
        ...scenarios.filter((scenario) => scenario.scenarioId === 'capacity')
    ];
}

function isHetznerWithheldAlmScenario(scenarioKey: string, carrier: AlmConformanceCarrier): boolean {
    return HETZNER_WITHHELD_ALM_SCENARIOS.some((withheld) =>
        withheld.scenarioKey === scenarioKey && withheld.carriers.includes(carrier)
    );
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
    const messageTypeIds = computeCombinedAlmMessageTypeIds(scenarios, role);
    const toConnect = (command: RallarBlackBoxTestRtcConnectCommand) =>
        toCombinedAlmConnect(command, rtcConnect.readiness, messageTypeIds);
    const prologueEnd = rtc.commands.indexOf(rtcConnect);
    const prologue = rtc.commands.slice(0, prologueEnd + 1).filter((command) =>
        command.kind === 'http.request' || command.kind === 'rtc.connect'
    ).map((command) => command.kind === 'rtc.connect' ? toConnect(command) : command);
    return [
        ...prologue,
        ...scenarios.flatMap((scenario) => {
            const recipe = toRoleRecipe(scenario, role);
            const commands = recipe.commands;
            const scenarioConnectAt = commands.findIndex((command) => command.kind === 'rtc.connect');
            if (scenarioConnectAt < 0) {
                throw new Error(`Generated ALM recipe ${recipe.recipeId} has no rtc.connect prologue.`);
            }
            return toBarrieredScenarioCommands(
                scenario,
                role,
                commands.slice(scenarioConnectAt + 1).map((command) =>
                    command.kind === 'rtc.connect' ? toConnect(command) : command
                )
            );
        })
    ];
}

/**
 * The combined recipe runs every role at once, so only barriers order one role's block against another's (D62).
 * `start`: every role finished the previous scenario, so no ACK of it is still owed when a fault is armed.
 * `armed`: every role armed the faults leading its block, so the sender sends into them.
 */
function toBarrieredScenarioCommands(
    scenario: AlmConformanceScenario,
    role: AlmConformanceRole,
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    const firstStep = commands.findIndex((command) => command.kind !== 'fault.inject');
    const armedEnd = firstStep < 0 ? commands.length : firstStep;
    const scenarioPrefix = toScenarioCarrierAndKey(scenario);
    return [
        toScenarioBarrier(scenarioPrefix, role, 'start'),
        ...commands.slice(0, armedEnd),
        toScenarioBarrier(scenarioPrefix, role, 'armed'),
        ...commands.slice(armedEnd)
    ];
}

function toScenarioBarrier(
    scenarioPrefix: string,
    role: AlmConformanceRole,
    phase: 'start' | 'armed'
): RallarBlackBoxTestBarrierCommand {
    return {
        kind: 'barrier',
        commandId: `${scenarioPrefix}-${role}-${phase}`,
        barrierId: `${scenarioPrefix}-${phase}`,
        timeoutMs: ALM_COMBINED_SCENARIO_BARRIER_TIMEOUT_MS
    };
}

/** Matches `toCommandId`'s own `alm-<carrier>-<scenarioKey>` prefix; `scenarioId` alone collides across scenarioKeys. */
function toScenarioCarrierAndKey(scenario: AlmConformanceScenario): string {
    const carrier = scenario.sender.metadata?.carrier;
    if (typeof carrier !== 'string') {
        throw new Error(`Generated ALM scenario ${scenario.scenarioKey} is missing its carrier metadata.`);
    }
    return `alm-${carrier}-${scenario.scenarioKey}`;
}

/**
 * A new sender document must recover the shared RTC-ready subscription before later mixed-carrier work. The topic
 * selector hears every type on WS; RTC inbox callbacks are registered per type, so the connect also lists them.
 */
function toCombinedAlmConnect(
    command: RallarBlackBoxTestRtcConnectCommand,
    readiness: RallarBlackBoxTestRtcConnectCommand['readiness'],
    messageTypeIds: readonly string[]
): RallarBlackBoxTestRtcConnectCommand {
    return {
        ...command,
        transport: 'messages.rtc',
        readiness,
        rallar: { ...command.rallar, messageSelector: { topicId: 'room.alm-conformance' }, messageTypeIds }
    };
}

/** Control types are absent on purpose: a raw `messages.control` ACK is the origin's refusal to observe, not a harness subscription (the RTC inbox map replaces, never adds, a callback per type). */
function computeCombinedAlmMessageTypeIds(
    scenarios: readonly AlmConformanceScenario[],
    role: AlmConformanceRole
): readonly string[] {
    const typeIds = scenarios.flatMap((scenario) => toRoleRecipe(scenario, role).commands.flatMap(toScenarioTypeIds));
    return [...new Set(typeIds)].sort();
}

function toScenarioTypeIds(command: RallarBlackBoxTestCommand): readonly string[] {
    if (command.kind === 'rtc.connect') {
        const typeId = command.rallar?.typeId;
        return typeof typeId === 'string' ? [typeId] : [];
    }
    if (isRallarBlackBoxTestMessagesSendCommand(command) || command.kind === 'messages.received') {
        return [command.typeId];
    }
    return [];
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
