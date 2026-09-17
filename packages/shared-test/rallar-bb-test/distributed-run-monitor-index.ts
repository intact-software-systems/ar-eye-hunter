import type {
    ControlEventEnvelope,
    ControlResultEnvelope
} from './control-protocol.ts';
import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunCommandPhase,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import {
    createDistributedRunMonitorMembershipIndex,
    type DistributedRunMonitorMembershipIndex
} from './distributed-run-monitor-membership-index.ts';
import { hasDistributedRunReference } from './has-distributed-run-reference.ts';

export interface DistributedRunMonitorAgentLinks {
    readonly all: readonly ControlDistributedRunCommandLink[];
    readonly stage: readonly ControlDistributedRunCommandLink[];
    readonly barrier: readonly ControlDistributedRunCommandLink[];
    readonly start: readonly ControlDistributedRunCommandLink[];
    readonly cancel: readonly ControlDistributedRunCommandLink[];
}

export interface DistributedRunMonitorRecipeProgressLinks {
    readonly start: readonly ControlDistributedRunCommandLink[];
    readonly stage: readonly ControlDistributedRunCommandLink[];
}

export interface DistributedRunMonitorCommandCounts {
    readonly total: number;
    readonly stage: number;
    readonly barrier: number;
    readonly start: number;
    readonly cancel: number;
    readonly completed: number;
    readonly failed: number;
    readonly pending: number;
}

export interface DistributedRunMonitorResultCounts {
    readonly total: number;
    readonly ok: number;
    readonly failed: number;
}

export interface DistributedRunMonitorIndex {
    readonly agentIds: readonly string[];
    readonly commandLinks: readonly ControlDistributedRunCommandLink[];
    readonly commandsById: ReadonlyMap<string, ControlQueuedCommandSnapshot>;
    readonly linkedResults: readonly ControlResultEnvelope[];
    readonly resultsByCommandId: ReadonlyMap<string, ControlResultEnvelope>;
    readonly linkedControlEvents: readonly ControlEventEnvelope[];
    readonly linksByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink>;
    readonly firstCommandPhasesById: ReadonlyMap<string, ControlDistributedRunCommandPhase>;
    readonly linksByAgentId: ReadonlyMap<string, DistributedRunMonitorAgentLinks>;
    readonly linksByRecipeId: ReadonlyMap<string, readonly ControlDistributedRunCommandLink[]>;
    readonly progressLinksByRecipeId: ReadonlyMap<string, DistributedRunMonitorRecipeProgressLinks>;
    readonly membership: DistributedRunMonitorMembershipIndex;
    readonly commandCounts: DistributedRunMonitorCommandCounts;
    readonly resultCounts: DistributedRunMonitorResultCounts;
    readonly latencies: readonly number[];
}

export interface CreateDistributedRunMonitorIndexInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    /** Absent when the control run snapshot is unavailable, so only the distributed run's own links are indexed. */
    readonly controlRun?: ControlRunSnapshot;
}

type MutableAgentLinks = {
    -readonly [Key in keyof DistributedRunMonitorAgentLinks]: ControlDistributedRunCommandLink[];
};

interface MutableRecipeProgressLinks {
    start: ControlDistributedRunCommandLink[];
    stage: ControlDistributedRunCommandLink[];
}

interface CommandLinkIndex {
    readonly commandLinks: readonly ControlDistributedRunCommandLink[];
    readonly agentIds: ReadonlySet<string>;
    readonly linksByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink>;
    readonly firstCommandPhasesById: ReadonlyMap<string, ControlDistributedRunCommandPhase>;
    readonly linkCountByCommandId: ReadonlyMap<string, number>;
    readonly linksByAgentId: ReadonlyMap<string, DistributedRunMonitorAgentLinks>;
    readonly linksByRecipeId: ReadonlyMap<string, readonly ControlDistributedRunCommandLink[]>;
    readonly progressLinksByRecipeId: ReadonlyMap<string, DistributedRunMonitorRecipeProgressLinks>;
    readonly phaseCounts: Readonly<Record<ControlDistributedRunCommandPhase, number>>;
}

interface MutableCommandLinkIndex extends CommandLinkIndex {
    readonly commandLinks: ControlDistributedRunCommandLink[];
    readonly agentIds: Set<string>;
    readonly linksByCommandId: Map<string, ControlDistributedRunCommandLink>;
    readonly firstCommandPhasesById: Map<string, ControlDistributedRunCommandPhase>;
    readonly linkCountByCommandId: Map<string, number>;
    readonly linksByAgentId: Map<string, MutableAgentLinks>;
    readonly linksByRecipeId: Map<string, ControlDistributedRunCommandLink[]>;
    readonly progressLinksByRecipeId: Map<string, MutableRecipeProgressLinks>;
    readonly phaseCounts: Record<ControlDistributedRunCommandPhase, number>;
}

interface LinkedResultIndex {
    readonly linkedResults: readonly ControlResultEnvelope[];
    readonly resultsByCommandId: ReadonlyMap<string, ControlResultEnvelope>;
    readonly latencies: readonly number[];
    readonly ok: number;
    readonly failed: number;
}

interface CommandCountsInput {
    readonly links: CommandLinkIndex;
    readonly results: LinkedResultIndex;
    readonly commandsById: ReadonlyMap<string, ControlQueuedCommandSnapshot>;
}

export function createDistributedRunMonitorIndex(
    input: CreateDistributedRunMonitorIndexInput
): DistributedRunMonitorIndex {
    const membership = createDistributedRunMonitorMembershipIndex(input.distributedRun);
    const links = toCommandLinkIndex(input.distributedRun, membership);
    const commandsById = toControlCommandIndex(input.controlRun);
    const results = toLinkedResultIndex(input.controlRun, links);

    return {
        agentIds: [...links.agentIds].sort(),
        commandLinks: links.commandLinks,
        commandsById,
        linkedResults: results.linkedResults,
        resultsByCommandId: results.resultsByCommandId,
        linkedControlEvents: toLinkedControlEvents(input, links),
        linksByCommandId: links.linksByCommandId,
        firstCommandPhasesById: links.firstCommandPhasesById,
        linksByAgentId: links.linksByAgentId,
        linksByRecipeId: links.linksByRecipeId,
        progressLinksByRecipeId: links.progressLinksByRecipeId,
        membership,
        commandCounts: computeCommandCounts({ links, results, commandsById }),
        resultCounts: { total: results.linkedResults.length, ok: results.ok, failed: results.failed },
        latencies: results.latencies
    };
}

export function getDistributedRunMonitorAgentLinks(
    index: DistributedRunMonitorIndex,
    agentId: string
): DistributedRunMonitorAgentLinks {
    return index.linksByAgentId.get(agentId) ?? createEmptyAgentLinks();
}

/** A recipe's start links once any were queued, otherwise its stage links. */
export function resolveDistributedRunMonitorRecipeLinks(
    index: DistributedRunMonitorIndex,
    recipeId: string
): readonly ControlDistributedRunCommandLink[] {
    const links = index.progressLinksByRecipeId.get(recipeId);
    return links === undefined
        ? []
        : links.start.length > 0
        ? links.start
        : links.stage;
}

export function getDistributedRunMonitorReadinessStageLinks(
    index: DistributedRunMonitorIndex,
    agentId: string
): readonly ControlDistributedRunCommandLink[] {
    return index.linksByAgentId.get(agentId)?.stage ?? [];
}

function toCommandLinkIndex(
    distributedRun: ControlDistributedRunSnapshot,
    membership: DistributedRunMonitorMembershipIndex
): CommandLinkIndex {
    const index = createEmptyCommandLinkIndex(membership);
    // A link without a recipe belongs to the only recipe of a single-recipe run and to no recipe otherwise.
    const soleRecipeId = membership.recipes.length === 1 ? membership.recipes[0]?.recipeId : undefined;
    for (const link of distributedRun.commandLinks) {
        addCommandLink(index, link, link.recipeId ?? soleRecipeId);
    }
    return index;
}

function createEmptyCommandLinkIndex(membership: DistributedRunMonitorMembershipIndex): MutableCommandLinkIndex {
    return {
        commandLinks: [],
        agentIds: new Set(membership.targetAgentIds),
        linksByCommandId: new Map(),
        firstCommandPhasesById: new Map(),
        linkCountByCommandId: new Map(),
        linksByAgentId: new Map(membership.targetAgentIds.map((agentId) => [agentId, createEmptyAgentLinks()])),
        linksByRecipeId: new Map(membership.recipes.map((recipe) => [recipe.recipeId, []])),
        progressLinksByRecipeId: new Map(
            membership.recipes.map((recipe) => [recipe.recipeId, { start: [], stage: [] }])
        ),
        phaseCounts: { stage: 0, barrier: 0, start: 0, cancel: 0 }
    };
}

function addCommandLink(
    index: MutableCommandLinkIndex,
    link: ControlDistributedRunCommandLink,
    recipeId: string | undefined
): void {
    index.commandLinks.push(link);
    index.linksByCommandId.set(link.commandId, link);
    if (!index.firstCommandPhasesById.has(link.commandId)) {
        index.firstCommandPhasesById.set(link.commandId, link.phase);
    }
    index.linkCountByCommandId.set(link.commandId, (index.linkCountByCommandId.get(link.commandId) ?? 0) + 1);
    index.agentIds.add(link.agentId);
    const agentLinks = index.linksByAgentId.get(link.agentId) ?? createEmptyAgentLinks();
    if (!index.linksByAgentId.has(link.agentId)) {
        index.linksByAgentId.set(link.agentId, agentLinks);
    }
    agentLinks.all.push(link);
    agentLinks[link.phase].push(link);
    index.phaseCounts[link.phase] += 1;
    if (recipeId !== undefined) {
        index.linksByRecipeId.get(recipeId)?.push(link);
        if (link.phase === 'start' || link.phase === 'stage') {
            index.progressLinksByRecipeId.get(recipeId)?.[link.phase].push(link);
        }
    }
}

function toControlCommandIndex(
    controlRun: ControlRunSnapshot | undefined
): ReadonlyMap<string, ControlQueuedCommandSnapshot> {
    const commandsById = new Map<string, ControlQueuedCommandSnapshot>();
    for (const command of controlRun?.commands ?? []) {
        commandsById.set(command.envelope.commandId, command);
    }
    return commandsById;
}

function toLinkedResultIndex(
    controlRun: ControlRunSnapshot | undefined,
    links: CommandLinkIndex
): LinkedResultIndex {
    const linkedResults: ControlResultEnvelope[] = [];
    const resultsByCommandId = new Map<string, ControlResultEnvelope>();
    const latencies: number[] = [];
    for (const result of controlRun?.results ?? []) {
        if (!links.linksByCommandId.has(result.commandId)) {
            continue;
        }
        linkedResults.push(result);
        resultsByCommandId.set(result.commandId, result);
        const durationMs = result.result?.durationMs;
        if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            latencies.push(durationMs);
        }
    }
    const ok = linkedResults.filter((result) => result.ok).length;
    return {
        linkedResults,
        resultsByCommandId,
        latencies,
        ok,
        failed: linkedResults.length - ok
    };
}

/** Link-weighted command counts: a command linked twice counts twice. */
function computeCommandCounts(input: CommandCountsInput): DistributedRunMonitorCommandCounts {
    let completed = 0;
    let failed = 0;
    input.links.linkCountByCommandId.forEach((linkCount, commandId) => {
        const result = input.results.resultsByCommandId.get(commandId);
        if (result !== undefined || input.commandsById.get(commandId)?.completedAtEpochMs !== undefined) {
            completed += linkCount;
        }
        if (result?.ok === false) {
            failed += linkCount;
        }
    });
    const total = input.links.commandLinks.length;
    return {
        total,
        ...input.links.phaseCounts,
        completed,
        failed,
        pending: Math.max(0, total - completed)
    };
}

function toLinkedControlEvents(
    input: CreateDistributedRunMonitorIndexInput,
    links: CommandLinkIndex
): readonly ControlEventEnvelope[] {
    const distributedRunId = input.distributedRun.distributedRunId;
    return (input.controlRun?.events ?? []).filter((event) =>
        (event.commandId !== undefined && links.linksByCommandId.has(event.commandId)) ||
        (Boolean(event.payload) && hasDistributedRunReference(event, distributedRunId))
    );
}

function createEmptyAgentLinks(): MutableAgentLinks {
    return { all: [], stage: [], barrier: [], start: [], cancel: [] };
}
