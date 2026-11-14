import { expect } from '@playwright/test';

import type { AlmConformanceRole } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    findControlResult,
    FULL_STACK_CONTROL_BASE_URL,
    readControlRunUntil,
    type RecipeRun,
    type RecipeRunAgent
} from './full-stack-helpers.ts';

/** The run whose agents a gate run registers as the participants of its cells' barriers. */
export interface CellGateRunTarget extends Pick<RecipeRun, 'runId'> {
    readonly group: RallarBlackBoxDistributedGroupRef;
}

export interface CellGateRunInput {
    readonly run: CellGateRunTarget;
    /** Undefined for a family's one run; a same-context cell, whose owner page changes every cell, names its own. */
    readonly cellKey: string | undefined;
    /** Every role a cell's barrier names, and the agent that plays it. */
    readonly agentsByRole: ReadonlyMap<AlmConformanceRole, RecipeRunAgent>;
}

export interface StartCellGateRunInput extends CellGateRunInput {
    readonly run: CellGateRunTarget & RecipeRun;
}

/** A start root is one `health` command, answered as soon as the agent dispatches it. */
const GATE_START_TIMEOUT_MS = 30_000;
/** Only a staged run waits for acknowledgements this long, and the gate run starts without a stage. */
const GATE_ACK_TIMEOUT_MS = 10_000;

/**
 * A barrier's participants are the start links of the control run's latest started distributed run. The gate run
 * starts one trivial root per role, so every role a cell's barrier names resolves to its agent; the cells themselves
 * stay plain roots.
 */
export function toCellGateRunManifest(input: CellGateRunInput): RallarBlackBoxDistributedRunManifest {
    const distributedRunId = input.cellKey === undefined
        ? `${input.run.runId}-gate`
        : `${input.run.runId}-${input.cellKey}-gate`;
    const roles = [...input.agentsByRole];
    return {
        schemaVersion: 1,
        distributedRunId,
        controlRunId: input.run.runId,
        group: input.run.group,
        recipes: roles.map(([role]) => ({
            recipeId: `${distributedRunId}-${role}`,
            recipe: {
                schemaVersion: 1,
                recipeId: `${distributedRunId}-${role}`,
                commands: [{ kind: 'health', commandId: `${distributedRunId}-${role}-health` }]
            },
            role,
            variables: {}
        })),
        targetPolicy: { mode: 'selected-agents', agentIds: roles.map(([, agent]) => agent.agentId) },
        variables: {},
        roleAssignments: roles.map(([role, agent]) => ({ role, agentId: agent.agentId, recipeIds: [], variables: {} })),
        ackTimeoutMs: GATE_ACK_TIMEOUT_MS,
        barrier: { enabled: false },
        groupAssertions: [],
        metadata: {},
        startMode: 'manual'
    };
}

/** Registers and starts the gate run, and returns once every start root answered ok. */
export async function startCellGateRun(input: StartCellGateRunInput): Promise<void> {
    const manifest = toCellGateRunManifest(input);
    const created = await input.run.request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
        data: { manifest }
    });
    expect(created.status(), await created.text()).toBe(201);
    const response = await input.run.request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}/start`
    );
    const startText = await response.text();
    expect(response.status(), startText).toBe(202);
    const started = JSON.parse(startText) as ControlDistributedRunSnapshot;
    const starts = started.commandLinks.filter((link) => link.phase === 'start');
    if (starts.length !== manifest.recipes.length) {
        throw new Error(`${manifest.distributedRunId} did not start a root per role. Start response: ${startText}`);
    }
    await waitForStartRoots(input.run, starts, startText);
    console.info(
        `cell gate run ${manifest.distributedRunId} started: state=${started.state} ` +
            starts.map((link) => `${link.role}=${link.agentId}`).join(' ')
    );
}

async function waitForStartRoots(
    run: RecipeRun,
    starts: readonly ControlDistributedRunCommandLink[],
    startText: string
): Promise<void> {
    const read = await readControlRunUntil(run, {
        timeoutMs: GATE_START_TIMEOUT_MS,
        select: (snapshot) => starts.map((link) => findControlResult(snapshot, link.commandId)),
        accept: (results) => results.every((result) => result !== undefined)
    });
    if (read.kind !== 'accepted') {
        throw new Error(
            `Not every gate start root answered within ${GATE_START_TIMEOUT_MS} ms. Start response: ${startText}`
        );
    }
    if (read.value.some((result) => result?.ok !== true)) {
        throw new Error(`A gate start root failed. Start response: ${startText}`);
    }
}
