import type {
    ControlAgentSnapshot,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from './control-snapshots.ts';
import { isDistributedRunTerminalState } from './distributed-run.ts';

export type ControlSnapshotSelectionIndex = Readonly<{
    hasDistributedRunCollection: boolean;
    controlRunIdsByOrdinal: readonly string[];
    distributedRunIdsByOrdinal: readonly string[];
    distributedRunControlIdsByOrdinal: readonly string[];
    firstControlRunOrdinalById: ReadonlyMap<string, number>;
    /** Global Array.find semantics: the first source row with this ID. */
    firstDistributedRunOrdinalById: ReadonlyMap<string, number>;
    /** First source row for the exact ID/control pair, with no composite key. */
    firstDistributedRunOrdinalByIdAndControlRunId: ReadonlyMap<string, ReadonlyMap<string, number>>;
    controlRunOrdinalsByUpdatedDesc: readonly number[];
    distributedRunOrdinalsByUpdatedDesc: readonly number[];
    firstAgentOrdinalByControlRunId: ReadonlyMap<string, ReadonlyMap<string, number>>;
    firstCommandOrdinalByControlRunId: ReadonlyMap<string, ReadonlyMap<string, number>>;
    controlAgentOrdinalsByControlRunIdSorted: ReadonlyMap<string, readonly number[]>;
    controlCommandOrdinalsByControlRunAgentId: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
    queuedControlCommandCountByControlRunAgentId: ReadonlyMap<string, ReadonlyMap<string, number>>;
    /** Every compatible source row, preserving multiplicity and source order. */
    distributedRunOrdinalsByControlRunId: ReadonlyMap<string, readonly number[]>;
    distributedRunOrdinalsByControlRunIdUpdatedDesc: ReadonlyMap<string, readonly number[]>;
    activeDistributedRunOrdinalsByControlRunId: ReadonlyMap<string, readonly number[]>;
    targetDistributedRunOrdinalsByControlRunId: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
    commandLinkOrdinalsByDistributedRunOrdinal: ReadonlyMap<number, ReadonlyMap<string, readonly number[]>>;
    boardRoleByAgentIdByDistributedRunOrdinal: ReadonlyMap<number, ReadonlyMap<string, string>>;
    boardDistributedRunIdsInFirstInsertionOrder: readonly string[];
    boardFirstInsertionOrdinalByDistributedRunId: ReadonlyMap<string, number>;
    boardSourceWinnerOrdinalByDistributedRunId: ReadonlyMap<string, number>;
    boardSourceCountByDistributedRunId: ReadonlyMap<string, number>;
    boardDistributedRunOrdinalsByControlRunId: ReadonlyMap<string, readonly number[]>;
    boardTargetDistributedRunOrdinalsByControlRunId: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
}>;

export type ControlSnapshotBoardRunOverlayEntry =
    | Readonly<{
        kind: 'source';
        distributedRunId: string;
        firstInsertionOrdinal: number;
        sourceWinnerOrdinal: number;
        sourceCount: number;
    }>
    | Readonly<{
        kind: 'selected';
        distributedRunId: string;
        firstInsertionOrdinal: number;
        sourceWinnerOrdinal: number | undefined;
        sourceCount: number;
    }>;

export type ControlSnapshotSelectionIndexWork = Readonly<{
    controlRunVisitCount: number;
    controlAgentVisitCount: number;
    controlAgentSortedOrdinalProjectionVisitCount: number;
    controlCommandVisitCount: number;
    controlCommandAgentBucketWriteCount: number;
    queuedControlCommandCountIncrementCount: number;
    controlRunUpdatedOrderProjectionVisitCount: number;
    distributedRunVisitCount: number;
    distributedControlBucketWriteCount: number;
    distributedUpdatedControlBucketWriteCount: number;
    activeDistributedRunProjectionVisitCount: number;
    activeDistributedControlBucketWriteCount: number;
    distributedTargetAgentVisitCount: number;
    targetMembershipWriteCount: number;
    distributedCommandLinkVisitCount: number;
    commandLinkAgentBucketWriteCount: number;
    manifestRoleAssignmentVisitCount: number;
    targetResolutionRoleAssignmentVisitCount: number;
    boardRolePrecedenceWriteCount: number;
    distributedUpdatedOrderProjectionVisitCount: number;
    boardWinnerVisitCount: number;
    boardControlBucketWriteCount: number;
    boardTargetAgentVisitCount: number;
    boardTargetMembershipWriteCount: number;
}>;

type MutableWork = {
    -readonly [Key in keyof ControlSnapshotSelectionIndexWork]: number;
};

type CommandLinkIdentityTopology = Readonly<{
    agentIdsByDistributedRunOrdinal: readonly (readonly string[])[];
    commandIdsByDistributedRunOrdinal: readonly (readonly string[])[];
    phasesByDistributedRunOrdinal: readonly (readonly string[])[];
}>;

type ControlMemberIdentityTopology = Readonly<{
    agentIdsByControlRunId: ReadonlyMap<string, readonly string[]>;
    commandIdsByControlRunId: ReadonlyMap<string, readonly string[]>;
    commandAgentIdsByControlRunId: ReadonlyMap<string, readonly (string | undefined)[]>;
}>;

const workByIndex = new WeakMap<object, ControlSnapshotSelectionIndexWork>();
const commandLinkIdentityByIndex = new WeakMap<object, CommandLinkIdentityTopology>();
const controlMemberIdentityByIndex = new WeakMap<object, ControlMemberIdentityTopology>();

/**
 * Builds snapshot-selection topology without retaining any source snapshot
 * object. Every retained lookup value is an identity string or source ordinal.
 */
export function createControlSnapshotSelectionIndex(
    snapshot: ControlServerSnapshot
): ControlSnapshotSelectionIndex {
    const work = emptyWork();
    const controlRunIdsByOrdinal: string[] = [];
    const controlRunUpdatedAtByOrdinal: number[] = [];
    const firstControlRunOrdinalById = new Map<string, number>();
    const firstAgentOrdinalByControlRunId = new Map<string, ReadonlyMap<string, number>>();
    const firstCommandOrdinalByControlRunId = new Map<string, ReadonlyMap<string, number>>();
    const controlAgentOrdinalsByControlRunIdSorted = new Map<string, number[]>();
    const controlCommandOrdinalsByControlRunAgentId = new Map<string, Map<string, number[]>>();
    const queuedControlCommandCountByControlRunAgentId = new Map<string, Map<string, number>>();
    const agentIdsByControlRunId = new Map<string, readonly string[]>();
    const commandIdsByControlRunId = new Map<string, readonly string[]>();
    const commandAgentIdsByControlRunId = new Map<string, readonly (string | undefined)[]>();
    const controlRunOrdinalsByUpdatedDesc: number[] = [];

    snapshot.runs.forEach((run, runOrdinal) => {
        work.controlRunVisitCount += 1;
        controlRunIdsByOrdinal.push(run.runId);
        controlRunUpdatedAtByOrdinal.push(run.updatedAtEpochMs);
        controlRunOrdinalsByUpdatedDesc.push(runOrdinal);
        work.controlRunUpdatedOrderProjectionVisitCount += 1;
        if (firstControlRunOrdinalById.has(run.runId)) {
            return;
        }

        firstControlRunOrdinalById.set(run.runId, runOrdinal);
        const agents = new Map<string, number>();
        const agentIds: string[] = [];
        run.agents.forEach((agent, agentOrdinal) => {
            work.controlAgentVisitCount += 1;
            agentIds.push(agent.agentId);
            if (!agents.has(agent.agentId)) {
                agents.set(agent.agentId, agentOrdinal);
            }
        });
        firstAgentOrdinalByControlRunId.set(run.runId, agents);
        agentIdsByControlRunId.set(
            run.runId,
            Object.freeze(agentIds)
        );
        const sortedAgentOrdinals = run.agents.map((_agent, agentOrdinal) => {
            work.controlAgentSortedOrdinalProjectionVisitCount += 1;
            return agentOrdinal;
        });
        sortedAgentOrdinals.sort((left, right) =>
            compareText(run.agents[left]!.agentId, run.agents[right]!.agentId) ||
            left - right
        );
        controlAgentOrdinalsByControlRunIdSorted.set(run.runId, sortedAgentOrdinals);

        const commands = new Map<string, number>();
        const commandsByAgentId = new Map<string, number[]>();
        const queuedCommandCountByAgentId = new Map<string, number>();
        const commandIds: string[] = [];
        const commandAgentIds: (string | undefined)[] = [];
        run.commands.forEach((command, commandOrdinal) => {
            work.controlCommandVisitCount += 1;
            const commandId = command.envelope.commandId;
            commandIds.push(commandId);
            commandAgentIds.push(command.envelope.agentId);
            if (!commands.has(commandId)) {
                commands.set(commandId, commandOrdinal);
            }
            const agentId = command.envelope.agentId;
            if (agentId === undefined) {
                return;
            }
            appendOrdinal(commandsByAgentId, agentId, commandOrdinal);
            work.controlCommandAgentBucketWriteCount += 1;
            if (command.completedAtEpochMs === undefined) {
                incrementCount(queuedCommandCountByAgentId, agentId);
                work.queuedControlCommandCountIncrementCount += 1;
            }
        });
        firstCommandOrdinalByControlRunId.set(run.runId, commands);
        commandIdsByControlRunId.set(
            run.runId,
            Object.freeze(commandIds)
        );
        commandAgentIdsByControlRunId.set(
            run.runId,
            Object.freeze(commandAgentIds)
        );
        controlCommandOrdinalsByControlRunAgentId.set(run.runId, commandsByAgentId);
        queuedControlCommandCountByControlRunAgentId.set(
            run.runId,
            queuedCommandCountByAgentId
        );
    });
    controlRunOrdinalsByUpdatedDesc.sort((left, right) =>
        controlRunUpdatedAtByOrdinal[right]! - controlRunUpdatedAtByOrdinal[left]! ||
        compareText(controlRunIdsByOrdinal[left]!, controlRunIdsByOrdinal[right]!)
    );

    const distributedRuns = snapshot.distributedRuns ?? [];
    const distributedRunIdsByOrdinal: string[] = [];
    const distributedRunControlIdsByOrdinal: string[] = [];
    const distributedRunUpdatedAtByOrdinal: number[] = [];
    const firstDistributedRunOrdinalById = new Map<string, number>();
    const firstDistributedRunOrdinalByIdAndControlRunId = new Map<string, Map<string, number>>();
    const distributedRunOrdinalsByUpdatedDesc: number[] = [];
    const distributedRunOrdinalsByControlRunId = new Map<string, number[]>();
    const distributedRunOrdinalsByControlRunIdUpdatedDesc = new Map<string, number[]>();
    const activeDistributedRunOrdinalsByControlRunId = new Map<string, number[]>();
    const targetDistributedRunOrdinalsByControlRunId = new Map<string, Map<string, number[]>>();
    const commandLinkOrdinalsByDistributedRunOrdinal = new Map<number, Map<string, number[]>>();
    const boardRoleByAgentIdByDistributedRunOrdinal = new Map<number, Map<string, string>>();
    const commandLinkAgentIdsByDistributedRunOrdinal: string[][] = [];
    const commandLinkCommandIdsByDistributedRunOrdinal: string[][] = [];
    const commandLinkPhasesByDistributedRunOrdinal: string[][] = [];
    const boardDistributedRunIdsInFirstInsertionOrder: string[] = [];
    const boardFirstInsertionOrdinalByDistributedRunId = new Map<string, number>();
    const boardSourceWinnerOrdinalByDistributedRunId = new Map<string, number>();
    const boardSourceCountByDistributedRunId = new Map<string, number>();

    distributedRuns.forEach((run, runOrdinal) => {
        work.distributedRunVisitCount += 1;
        distributedRunIdsByOrdinal.push(run.distributedRunId);
        distributedRunControlIdsByOrdinal.push(run.controlRunId);
        distributedRunUpdatedAtByOrdinal.push(run.updatedAtEpochMs);
        distributedRunOrdinalsByUpdatedDesc.push(runOrdinal);
        work.distributedUpdatedOrderProjectionVisitCount += 1;
        if (!firstDistributedRunOrdinalById.has(run.distributedRunId)) {
            firstDistributedRunOrdinalById.set(run.distributedRunId, runOrdinal);
        }
        setNestedFirstOrdinal(
            firstDistributedRunOrdinalByIdAndControlRunId,
            run.distributedRunId,
            run.controlRunId,
            runOrdinal
        );
        appendOrdinal(distributedRunOrdinalsByControlRunId, run.controlRunId, runOrdinal);
        work.distributedControlBucketWriteCount += 1;
        appendOrdinal(
            distributedRunOrdinalsByControlRunIdUpdatedDesc,
            run.controlRunId,
            runOrdinal
        );
        work.distributedUpdatedControlBucketWriteCount += 1;

        work.activeDistributedRunProjectionVisitCount += 1;
        if (!isDistributedRunTerminalState(run.state)) {
            appendOrdinal(
                activeDistributedRunOrdinalsByControlRunId,
                run.controlRunId,
                runOrdinal
            );
            work.activeDistributedControlBucketWriteCount += 1;
        }

        const seenTargets = new Set<string>();
        run.targetAgentIds.forEach((agentId) => {
            work.distributedTargetAgentVisitCount += 1;
            if (seenTargets.has(agentId)) {
                return;
            }
            seenTargets.add(agentId);
            appendNestedOrdinal(
                targetDistributedRunOrdinalsByControlRunId,
                run.controlRunId,
                agentId,
                runOrdinal
            );
            work.targetMembershipWriteCount += 1;
        });

        const linksByAgentId = new Map<string, number[]>();
        const roleByAgentId = new Map<string, string>();
        const linkRoleAgentIds = new Set<string>();
        const linkAgentIds: string[] = [];
        const linkCommandIds: string[] = [];
        const linkPhases: string[] = [];
        run.commandLinks.forEach((link, linkOrdinal) => {
            work.distributedCommandLinkVisitCount += 1;
            appendOrdinal(linksByAgentId, link.agentId, linkOrdinal);
            work.commandLinkAgentBucketWriteCount += 1;
            linkAgentIds.push(link.agentId);
            linkCommandIds.push(link.commandId);
            linkPhases.push(link.phase);
            if (!linkRoleAgentIds.has(link.agentId)) {
                linkRoleAgentIds.add(link.agentId);
                if (typeof link.role === 'string') {
                    roleByAgentId.set(link.agentId, link.role);
                    work.boardRolePrecedenceWriteCount += 1;
                }
            }
        });
        commandLinkOrdinalsByDistributedRunOrdinal.set(runOrdinal, linksByAgentId);
        commandLinkAgentIdsByDistributedRunOrdinal.push(linkAgentIds);
        commandLinkCommandIdsByDistributedRunOrdinal.push(linkCommandIds);
        commandLinkPhasesByDistributedRunOrdinal.push(linkPhases);

        const manifestRoleAgentIds = new Set<string>();
        (run.manifest.roleAssignments ?? []).forEach((assignment) => {
            work.manifestRoleAssignmentVisitCount += 1;
            if (manifestRoleAgentIds.has(assignment.agentId)) {
                return;
            }
            manifestRoleAgentIds.add(assignment.agentId);
            if (typeof assignment.role === 'string') {
                roleByAgentId.set(assignment.agentId, assignment.role);
                work.boardRolePrecedenceWriteCount += 1;
            }
        });
        const resolutionRoleAgentIds = new Set<string>();
        (run.targetResolution?.roleAssignments ?? []).forEach((assignment) => {
            work.targetResolutionRoleAssignmentVisitCount += 1;
            if (resolutionRoleAgentIds.has(assignment.agentId)) {
                return;
            }
            resolutionRoleAgentIds.add(assignment.agentId);
            if (typeof assignment.role === 'string') {
                roleByAgentId.set(assignment.agentId, assignment.role);
                work.boardRolePrecedenceWriteCount += 1;
            }
        });
        boardRoleByAgentIdByDistributedRunOrdinal.set(runOrdinal, roleByAgentId);

        // Map#set replaces the payload without moving its insertion position.
        if (!boardFirstInsertionOrdinalByDistributedRunId.has(run.distributedRunId)) {
            boardFirstInsertionOrdinalByDistributedRunId.set(
                run.distributedRunId,
                runOrdinal
            );
            boardDistributedRunIdsInFirstInsertionOrder.push(run.distributedRunId);
        }
        boardSourceWinnerOrdinalByDistributedRunId.set(
            run.distributedRunId,
            runOrdinal
        );
        incrementCount(boardSourceCountByDistributedRunId, run.distributedRunId);
    });

    distributedRunOrdinalsByUpdatedDesc.sort((left, right) =>
        compareDistributedUpdatedOrdinals(
            left,
            right,
            distributedRunUpdatedAtByOrdinal,
            distributedRunIdsByOrdinal
        )
    );
    distributedRunOrdinalsByControlRunIdUpdatedDesc.forEach((ordinals) => {
        ordinals.sort((left, right) =>
            compareDistributedUpdatedOrdinals(
                left,
                right,
                distributedRunUpdatedAtByOrdinal,
                distributedRunIdsByOrdinal
            )
        );
    });
    activeDistributedRunOrdinalsByControlRunId.forEach((ordinals) => {
        ordinals.sort((left, right) =>
            compareDistributedUpdatedOrdinals(
                left,
                right,
                distributedRunUpdatedAtByOrdinal,
                distributedRunIdsByOrdinal
            )
        );
    });

    const boardDistributedRunOrdinalsByControlRunId = new Map<string, number[]>();
    const boardTargetDistributedRunOrdinalsByControlRunId = new Map<string, Map<string, number[]>>();
    boardSourceWinnerOrdinalByDistributedRunId.forEach((runOrdinal) => {
        work.boardWinnerVisitCount += 1;
        const run = distributedRuns[runOrdinal]!;
        appendOrdinal(
            boardDistributedRunOrdinalsByControlRunId,
            run.controlRunId,
            runOrdinal
        );
        work.boardControlBucketWriteCount += 1;
        const seenTargets = new Set<string>();
        run.targetAgentIds.forEach((agentId) => {
            work.boardTargetAgentVisitCount += 1;
            if (seenTargets.has(agentId)) {
                return;
            }
            seenTargets.add(agentId);
            appendNestedOrdinal(
                boardTargetDistributedRunOrdinalsByControlRunId,
                run.controlRunId,
                agentId,
                runOrdinal
            );
            work.boardTargetMembershipWriteCount += 1;
        });
    });

    const index: ControlSnapshotSelectionIndex = Object.freeze({
        hasDistributedRunCollection: snapshot.distributedRuns !== undefined,
        controlRunIdsByOrdinal: Object.freeze(controlRunIdsByOrdinal),
        distributedRunIdsByOrdinal: Object.freeze(distributedRunIdsByOrdinal),
        distributedRunControlIdsByOrdinal: Object.freeze(distributedRunControlIdsByOrdinal),
        firstControlRunOrdinalById,
        firstDistributedRunOrdinalById,
        firstDistributedRunOrdinalByIdAndControlRunId,
        controlRunOrdinalsByUpdatedDesc: Object.freeze(controlRunOrdinalsByUpdatedDesc),
        distributedRunOrdinalsByUpdatedDesc: Object.freeze(distributedRunOrdinalsByUpdatedDesc),
        firstAgentOrdinalByControlRunId,
        firstCommandOrdinalByControlRunId,
        controlAgentOrdinalsByControlRunIdSorted: freezeMapArrays(controlAgentOrdinalsByControlRunIdSorted),
        controlCommandOrdinalsByControlRunAgentId: freezeNestedMapArrays(controlCommandOrdinalsByControlRunAgentId),
        queuedControlCommandCountByControlRunAgentId,
        distributedRunOrdinalsByControlRunId: freezeMapArrays(distributedRunOrdinalsByControlRunId),
        distributedRunOrdinalsByControlRunIdUpdatedDesc: freezeMapArrays(
            distributedRunOrdinalsByControlRunIdUpdatedDesc
        ),
        activeDistributedRunOrdinalsByControlRunId: freezeMapArrays(activeDistributedRunOrdinalsByControlRunId),
        targetDistributedRunOrdinalsByControlRunId: freezeNestedMapArrays(targetDistributedRunOrdinalsByControlRunId),
        commandLinkOrdinalsByDistributedRunOrdinal: freezeNestedMapArrays(commandLinkOrdinalsByDistributedRunOrdinal),
        boardRoleByAgentIdByDistributedRunOrdinal,
        boardDistributedRunIdsInFirstInsertionOrder: Object.freeze(boardDistributedRunIdsInFirstInsertionOrder),
        boardFirstInsertionOrdinalByDistributedRunId,
        boardSourceWinnerOrdinalByDistributedRunId,
        boardSourceCountByDistributedRunId,
        boardDistributedRunOrdinalsByControlRunId: freezeMapArrays(boardDistributedRunOrdinalsByControlRunId),
        boardTargetDistributedRunOrdinalsByControlRunId: freezeNestedMapArrays(
            boardTargetDistributedRunOrdinalsByControlRunId
        )
    });
    workByIndex.set(index, Object.freeze({ ...work }));
    commandLinkIdentityByIndex.set(index, {
        agentIdsByDistributedRunOrdinal: freezeNestedArrays(commandLinkAgentIdsByDistributedRunOrdinal),
        commandIdsByDistributedRunOrdinal: freezeNestedArrays(commandLinkCommandIdsByDistributedRunOrdinal),
        phasesByDistributedRunOrdinal: freezeNestedArrays(commandLinkPhasesByDistributedRunOrdinal)
    });
    controlMemberIdentityByIndex.set(index, {
        agentIdsByControlRunId,
        commandIdsByControlRunId,
        commandAgentIdsByControlRunId
    });
    return index;
}

export function rebindControlRunFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    runId: string
): ControlRunSnapshot | undefined {
    const ordinal = index.firstControlRunOrdinalById.get(runId);
    if (ordinal === undefined) {
        return undefined;
    }
    const run = snapshot.runs[ordinal];
    return run?.runId === runId && index.controlRunIdsByOrdinal[ordinal] === runId
        ? run
        : undefined;
}

export function rebindDistributedRunFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    distributedRunId: string
): ControlDistributedRunSnapshot | undefined {
    const ordinal = index.firstDistributedRunOrdinalById.get(distributedRunId);
    if (ordinal === undefined) {
        return undefined;
    }
    return distributedRunAtOrdinal(index, snapshot, ordinal);
}

/** Rebinds the first source row matching both ID and control-run identity. */
export function rebindDistributedRunPairFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    distributedRunId: string,
    controlRunId: string
): ControlDistributedRunSnapshot | undefined {
    const ordinal = index.firstDistributedRunOrdinalByIdAndControlRunId
        .get(distributedRunId)?.get(controlRunId);
    if (ordinal === undefined) {
        return undefined;
    }
    return distributedRunAtOrdinal(index, snapshot, ordinal);
}

/**
 * Reproduces `uniqueRuns([...source, selected])` as a primitive plan. The
 * caller rebinds source ordinals against the current poll and supplies the
 * selected object for the selected entry, so an external or mutated selected
 * payload can override a source winner without being retained by the index.
 */
export function createControlSnapshotBoardRunOverlayPlan(
    index: ControlSnapshotSelectionIndex,
    controlRunId: string,
    selected:
        | Readonly<{
            distributedRunId: string;
            controlRunId: string;
        }>
        | undefined
): readonly ControlSnapshotBoardRunOverlayEntry[] {
    const sourceOrdinals = index.boardDistributedRunOrdinalsByControlRunId.get(controlRunId) ?? [];
    const entries: ControlSnapshotBoardRunOverlayEntry[] = [];
    for (const sourceWinnerOrdinal of sourceOrdinals) {
        const distributedRunId = index.distributedRunIdsByOrdinal[sourceWinnerOrdinal];
        if (
            distributedRunId === undefined ||
            distributedRunId === selected?.distributedRunId
        ) {
            continue;
        }
        entries.push(Object.freeze({
            kind: 'source',
            distributedRunId,
            firstInsertionOrdinal: index.boardFirstInsertionOrdinalByDistributedRunId
                .get(distributedRunId)!,
            sourceWinnerOrdinal,
            sourceCount: index.boardSourceCountByDistributedRunId.get(distributedRunId) ?? 0
        }));
    }

    if (selected?.controlRunId === controlRunId) {
        const firstInsertionOrdinal = index.boardFirstInsertionOrdinalByDistributedRunId
            .get(selected.distributedRunId) ?? index.distributedRunIdsByOrdinal.length;
        const selectedEntry: ControlSnapshotBoardRunOverlayEntry = Object.freeze({
            kind: 'selected',
            distributedRunId: selected.distributedRunId,
            firstInsertionOrdinal,
            sourceWinnerOrdinal: index.boardSourceWinnerOrdinalByDistributedRunId
                .get(selected.distributedRunId),
            sourceCount: index.boardSourceCountByDistributedRunId
                .get(selected.distributedRunId) ?? 0
        });
        const insertionIndex = entries.findIndex((entry) => entry.firstInsertionOrdinal > firstInsertionOrdinal);
        entries.splice(
            insertionIndex < 0 ? entries.length : insertionIndex,
            0,
            selectedEntry
        );
    }
    return Object.freeze(entries);
}

export function rebindControlAgentFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    controlRunId: string,
    agentId: string
): ControlAgentSnapshot | undefined {
    const run = rebindControlRunFromSelectionIndex(index, snapshot, controlRunId);
    const ordinal = index.firstAgentOrdinalByControlRunId.get(controlRunId)?.get(agentId);
    if (!run || ordinal === undefined) {
        return undefined;
    }
    const agent = run.agents[ordinal];
    return agent?.agentId === agentId ? agent : undefined;
}

export function rebindControlCommandFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    controlRunId: string,
    commandId: string
): ControlQueuedCommandSnapshot | undefined {
    const run = rebindControlRunFromSelectionIndex(index, snapshot, controlRunId);
    const ordinal = index.firstCommandOrdinalByControlRunId.get(controlRunId)?.get(commandId);
    if (!run || ordinal === undefined) {
        return undefined;
    }
    const command = run.commands[ordinal];
    return command?.envelope.commandId === commandId ? command : undefined;
}

export function rebindControlAgentsFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    controlRunId: string,
    ordinals: readonly number[]
): readonly ControlAgentSnapshot[] {
    const run = rebindControlRunFromSelectionIndex(index, snapshot, controlRunId);
    const expectedIds = controlMemberIdentityByIndex.get(index)
        ?.agentIdsByControlRunId.get(controlRunId);
    if (!run || !expectedIds) {
        return [];
    }
    const rebound: ControlAgentSnapshot[] = [];
    for (const ordinal of ordinals) {
        const agent = run.agents[ordinal];
        if (!agent || agent.agentId !== expectedIds[ordinal]) {
            return [];
        }
        rebound.push(agent);
    }
    return rebound;
}

export function rebindControlCommandsFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    controlRunId: string,
    ordinals: readonly number[]
): readonly ControlQueuedCommandSnapshot[] {
    const run = rebindControlRunFromSelectionIndex(index, snapshot, controlRunId);
    const identities = controlMemberIdentityByIndex.get(index);
    const expectedIds = identities?.commandIdsByControlRunId.get(controlRunId);
    const expectedAgentIds = identities?.commandAgentIdsByControlRunId.get(controlRunId);
    if (!run || !expectedIds || !expectedAgentIds) {
        return [];
    }
    const rebound: ControlQueuedCommandSnapshot[] = [];
    for (const ordinal of ordinals) {
        const command = run.commands[ordinal];
        if (
            !command || command.envelope.commandId !== expectedIds[ordinal] ||
            command.envelope.agentId !== expectedAgentIds[ordinal]
        ) {
            return [];
        }
        rebound.push(command);
    }
    return rebound;
}

export function rebindControlRunsFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    ordinals: readonly number[]
): readonly ControlRunSnapshot[] {
    const rebound: ControlRunSnapshot[] = [];
    for (const ordinal of ordinals) {
        const run = snapshot.runs[ordinal];
        if (!run || run.runId !== index.controlRunIdsByOrdinal[ordinal]) {
            return [];
        }
        rebound.push(run);
    }
    return rebound;
}

export function rebindDistributedRunsFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    ordinals: readonly number[]
): readonly ControlDistributedRunSnapshot[] {
    const rebound: ControlDistributedRunSnapshot[] = [];
    for (const ordinal of ordinals) {
        const run = distributedRunAtOrdinal(index, snapshot, ordinal);
        if (!run) {
            return [];
        }
        rebound.push(run);
    }
    return rebound;
}

export function rebindCommandLinksFromSelectionIndex(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    distributedRunOrdinal: number,
    linkOrdinals: readonly number[]
): readonly ControlDistributedRunCommandLink[] {
    const run = distributedRunAtOrdinal(index, snapshot, distributedRunOrdinal);
    const identities = commandLinkIdentityByIndex.get(index);
    if (!run || !identities) {
        return [];
    }
    const agentIds = identities.agentIdsByDistributedRunOrdinal[distributedRunOrdinal];
    const commandIds = identities.commandIdsByDistributedRunOrdinal[distributedRunOrdinal];
    const phases = identities.phasesByDistributedRunOrdinal[distributedRunOrdinal];
    if (!agentIds || !commandIds || !phases) {
        return [];
    }

    const rebound: ControlDistributedRunCommandLink[] = [];
    for (const ordinal of linkOrdinals) {
        const link = run.commandLinks[ordinal];
        if (
            !link || link.agentId !== agentIds[ordinal] ||
            link.commandId !== commandIds[ordinal] || link.phase !== phases[ordinal]
        ) {
            return [];
        }
        rebound.push(link);
    }
    return rebound;
}

export function controlSnapshotSelectionIndexWorkForTest(
    index: ControlSnapshotSelectionIndex
): ControlSnapshotSelectionIndexWork | undefined {
    return workByIndex.get(index);
}

function distributedRunAtOrdinal(
    index: ControlSnapshotSelectionIndex,
    snapshot: ControlServerSnapshot,
    ordinal: number
): ControlDistributedRunSnapshot | undefined {
    const run = snapshot.distributedRuns?.[ordinal];
    return run && run.distributedRunId === index.distributedRunIdsByOrdinal[ordinal] &&
            run.controlRunId === index.distributedRunControlIdsByOrdinal[ordinal]
        ? run
        : undefined;
}

function appendOrdinal<Key>(
    map: Map<Key, number[]>,
    key: Key,
    ordinal: number
): void {
    const current = map.get(key);
    if (current) {
        current.push(ordinal);
    }
    else {
        map.set(key, [ordinal]);
    }
}

function appendNestedOrdinal<OuterKey, InnerKey>(
    map: Map<OuterKey, Map<InnerKey, number[]>>,
    outerKey: OuterKey,
    innerKey: InnerKey,
    ordinal: number
): void {
    let nested = map.get(outerKey);
    if (!nested) {
        nested = new Map<InnerKey, number[]>();
        map.set(outerKey, nested);
    }
    appendOrdinal(nested, innerKey, ordinal);
}

function setNestedFirstOrdinal<OuterKey, InnerKey>(
    map: Map<OuterKey, Map<InnerKey, number>>,
    outerKey: OuterKey,
    innerKey: InnerKey,
    ordinal: number
): void {
    let nested = map.get(outerKey);
    if (!nested) {
        nested = new Map<InnerKey, number>();
        map.set(outerKey, nested);
    }
    if (!nested.has(innerKey)) {
        nested.set(innerKey, ordinal);
    }
}

function incrementCount<Key>(map: Map<Key, number>, key: Key): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function compareDistributedUpdatedOrdinals(
    left: number,
    right: number,
    updatedAtByOrdinal: readonly number[],
    idsByOrdinal: readonly string[]
): number {
    return updatedAtByOrdinal[right]! - updatedAtByOrdinal[left]! ||
        compareText(idsByOrdinal[left]!, idsByOrdinal[right]!);
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right);
}

function freezeMapArrays<Key>(
    map: Map<Key, number[]>
): ReadonlyMap<Key, readonly number[]> {
    map.forEach((ordinals) => Object.freeze(ordinals));
    return map;
}

function freezeNestedMapArrays<OuterKey, InnerKey>(
    map: Map<OuterKey, Map<InnerKey, number[]>>
): ReadonlyMap<OuterKey, ReadonlyMap<InnerKey, readonly number[]>> {
    map.forEach((nested) => freezeMapArrays(nested));
    return map;
}

function freezeNestedArrays(values: string[][]): readonly (readonly string[])[] {
    values.forEach((value) => Object.freeze(value));
    return Object.freeze(values);
}

function emptyWork(): MutableWork {
    return {
        controlRunVisitCount: 0,
        controlAgentVisitCount: 0,
        controlAgentSortedOrdinalProjectionVisitCount: 0,
        controlCommandVisitCount: 0,
        controlCommandAgentBucketWriteCount: 0,
        queuedControlCommandCountIncrementCount: 0,
        controlRunUpdatedOrderProjectionVisitCount: 0,
        distributedRunVisitCount: 0,
        distributedControlBucketWriteCount: 0,
        distributedUpdatedControlBucketWriteCount: 0,
        activeDistributedRunProjectionVisitCount: 0,
        activeDistributedControlBucketWriteCount: 0,
        distributedTargetAgentVisitCount: 0,
        targetMembershipWriteCount: 0,
        distributedCommandLinkVisitCount: 0,
        commandLinkAgentBucketWriteCount: 0,
        manifestRoleAssignmentVisitCount: 0,
        targetResolutionRoleAssignmentVisitCount: 0,
        boardRolePrecedenceWriteCount: 0,
        distributedUpdatedOrderProjectionVisitCount: 0,
        boardWinnerVisitCount: 0,
        boardControlBucketWriteCount: 0,
        boardTargetAgentVisitCount: 0,
        boardTargetMembershipWriteCount: 0
    };
}
