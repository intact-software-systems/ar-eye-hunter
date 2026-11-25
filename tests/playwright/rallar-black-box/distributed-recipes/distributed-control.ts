import { expect, type APIRequestContext } from '@playwright/test';

import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';

import { type ControlResultEnvelope } from '../../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import {
    type ControlDistributedRunArtifactBundle,
    type ControlDistributedRunSnapshot
} from '../../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { computeDistributedRunTerminalTimeoutSeconds } from '../../../../packages/shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import {
    type RallarBlackBoxDistributedGroupRef,
    type RallarBlackBoxDistributedRunManifest
} from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { type RallarBlackBoxTestCommand } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeControlDistributedRunArtifactBundle } from '../../../../packages/shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';

import { createDistributedRun, mutateDistributedRun, throwBoundaryError } from '../distributed-run-requests.ts';
import {
    enqueueControlCommand,
    FULL_STACK_CONTROL_BASE_URL,
    readControlRun
} from '../full-stack-helpers.ts';

interface WaitForCommandResultInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly commandId: string;
    readonly timeout: number;
}

interface ExecuteOkInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
    readonly timeout: number;
}

interface WaitForAgentsInGroupInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agentIds: readonly string[];
    readonly group: RallarBlackBoxDistributedGroupRef;
}

interface WaitForDistributedStateInput {
    readonly request: APIRequestContext;
    readonly distributedRunId: string;
    readonly state: string;
    readonly timeout?: number;
}

/** How long a state wait polls when no recipe command runs before that state, such as a staged run becoming ready. */
export const DISTRIBUTED_STATE_POLL_TIMEOUT_MS = 45_000;

/** How long the control run is polled until every agent reports the distributed group. */
export const AGENTS_IN_GROUP_POLL_TIMEOUT_MS = 20_000;

async function waitForCommandResult(input: WaitForCommandResultInput): Promise<ControlResultEnvelope> {
    const { request, runId, commandId, timeout } = input;

    let latest: ControlResultEnvelope | undefined;
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        latest = run.results.find((result) => result.commandId === commandId);
        return Boolean(latest);
    }, { timeout }).toBe(true);
    if (!latest) {
        throw new Error(`Command ${commandId} did not return a result.`);
    }
    return latest;
}

export async function executeOk(input: ExecuteOkInput): Promise<ControlResultEnvelope> {
    const { request, runId, agentId, commandId, command, timeout } = input;

    await enqueueControlCommand({ request, runId, agentId, commandId, command });
    const result = await waitForCommandResult({ request, runId, commandId, timeout });
    expect(result.ok).toBe(true);
    return result;
}

export async function waitForAgentsInGroup(input: WaitForAgentsInGroupInput): Promise<void> {
    const { request, runId, agentIds, group } = input;

    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return agentIds.every((agentId) => {
            const agent = run.agents.find((candidate) => candidate.agentId === agentId);
            return agent?.connected === true &&
                agent.identity?.applicationId === group.applicationId &&
                agent.identity.workspaceId === group.workspaceId &&
                agent.identity.groupId === group.groupId;
        });
    }, { timeout: AGENTS_IN_GROUP_POLL_TIMEOUT_MS }).toBe(true);
}

async function readDistributedRun(
    request: APIRequestContext,
    distributedRunId: string
): Promise<ControlDistributedRunSnapshot> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}`,
        { timeout: CONTROL_REQUEST_TIMEOUT_MS }
    );
    expect(response.ok()).toBe(true);
    return decodeControlDistributedRunSnapshot(await response.json()).fold(throwBoundaryError, (value) => value);
}

export async function waitForDistributedState(
    input: WaitForDistributedStateInput
): Promise<ControlDistributedRunSnapshot> {
    const { request, distributedRunId, state, timeout = DISTRIBUTED_STATE_POLL_TIMEOUT_MS } = input;

    let latest: ControlDistributedRunSnapshot | undefined;
    try {
        await expect.poll(async () => {
            latest = await readDistributedRun(request, distributedRunId);
            return latest.state;
        }, { timeout }).toBe(state);
    }
    catch (error) {
        const snapshot = latest
            ? JSON.stringify(
                {
                    distributedRunId: latest.distributedRunId,
                    state: latest.state,
                    targetAgentIds: latest.targetAgentIds,
                    commandLinks: latest.commandLinks,
                    error: latest.error,
                    rollup: latest.rollup
                },
                null,
                2
            )
            : 'none';
        throw new Error(
            `Distributed run ${distributedRunId} did not reach ${state}. Latest snapshot: ${snapshot}`,
            { cause: error }
        );
    }
    if (!latest) {
        throw new Error(`Distributed run ${distributedRunId} did not reach ${state}.`);
    }
    return latest;
}

export async function readDistributedArtifact(
    request: APIRequestContext,
    distributedRunId: string
): Promise<ControlDistributedRunArtifactBundle> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}/artifacts`,
        { timeout: CONTROL_REQUEST_TIMEOUT_MS }
    );
    expect(response.ok()).toBe(true);
    return decodeControlDistributedRunArtifactBundle(await response.json()).fold(throwBoundaryError, (value) => value);
}

/** A started run passes at the latest once its ack, its barrier and its slowest recipe end, and the state poll reads it. */
export function computeDistributedRunPassedWaitMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    const terminalTimeoutSeconds = computeDistributedRunTerminalTimeoutSeconds({
        recipes: manifest.recipes.flatMap((selection) => selection.recipe === undefined ? [] : [selection.recipe]),
        ackTimeoutMs: manifest.ackTimeoutMs,
        barrier: manifest.barrier
    });
    return terminalTimeoutSeconds * 1_000 + DISTRIBUTED_STATE_POLL_TIMEOUT_MS;
}

/** What `runToPassed` waits: the staged run becoming ready, then the started run passing. */
export function computeDistributedRunToPassedWaitMs(manifest: RallarBlackBoxDistributedRunManifest): number {
    return DISTRIBUTED_STATE_POLL_TIMEOUT_MS + computeDistributedRunPassedWaitMs(manifest);
}

/** Runs the manifest to passed, waiting for passed as long as the run may take. */
export async function runToPassed(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<ControlDistributedRunSnapshot> {
    await createDistributedRun(request, manifest);
    await mutateDistributedRun(request, manifest.distributedRunId, 'stage');
    await waitForDistributedState({ request, distributedRunId: manifest.distributedRunId, state: 'ready' });
    await mutateDistributedRun(request, manifest.distributedRunId, 'start');
    return await waitForDistributedState({
        request,
        distributedRunId: manifest.distributedRunId,
        state: 'passed',
        timeout: computeDistributedRunPassedWaitMs(manifest)
    });
}
