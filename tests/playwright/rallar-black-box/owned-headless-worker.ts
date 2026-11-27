import { expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { toFullStackControlWebSocketUrl } from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import { toControllerAgentIds } from '../../../apps/rallar-black-box/src/hetzner/hetzner-manifest-entry.ts';
import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

import { ALL_LOCAL_ALM_REGISTRATION_TIMEOUT_MS } from './compute-all-local-alm-observation-deadlines.ts';

/** The local services the worker's agents load, sign in to and report to. */
export interface OwnedHeadlessWorkerServices {
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly controlBaseUrl: string;
}

/** One headless worker a spec starts for one distributed run and stops itself. */
export interface OwnedHeadlessWorkerLaunch {
    readonly services: OwnedHeadlessWorkerServices;
    readonly manifest: Pick<RallarBlackBoxDistributedRunManifest, 'controlRunId' | 'distributedRunId' | 'group'>;
    /** The worker runs the agents `controller-01` onward, the ids a role-map manifest targets. */
    readonly agentCount: number;
    /** The worker ends itself when its run has reached no terminal state after this long. */
    readonly idleExitMs: number;
}

export type OwnedHeadlessWorkerCleanup = 'not-started' | 'reaped' | 'unreaped';

/** How long a worker is given to end by itself, and again to end after it was asked to. */
const WORKER_EXIT_WAIT_MS = 20_000;

/** A worker still running this long after it was asked to end is killed. */
const WORKER_KILL_AFTER_MS = 10_000;

/**
 * The worker runs in its own process group, so stopping the group also stops its browser. Each agent registers a new
 * user named as its agent id, under a password of this launch: the API must not know the user yet.
 */
export function startOwnedHeadlessWorker(launch: OwnedHeadlessWorkerLaunch): ChildProcess {
    const { services, manifest } = launch;
    const credentials = Object.fromEntries(
        toControllerAgentIds(launch.agentCount).flatMap((agentId, index) => [
            [`RALLAR_BLACK_BOX_AGENT_${index + 1}_USERNAME`, agentId],
            [`RALLAR_BLACK_BOX_AGENT_${index + 1}_PASSWORD`, randomBytes(24).toString('hex')]
        ])
    );
    return spawn(process.execPath, ['--import', 'tsx', 'apps/rallar-black-box/scripts/headless-worker.ts'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            ...credentials,
            RALLAR_BLACK_BOX_SPA_URL: services.spaBaseUrl,
            RALLAR_BLACK_BOX_CONTROL_URL: toFullStackControlWebSocketUrl(services.controlBaseUrl),
            RALLAR_CONTROL_HTTP_URL: services.controlBaseUrl,
            RALLAR_API_BASE_URL: services.apiBaseUrl,
            RALLAR_BLACK_BOX_RUN_ID: manifest.controlRunId,
            RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID: manifest.distributedRunId,
            RALLAR_BLACK_BOX_AGENT_COUNT: String(launch.agentCount),
            RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
            RALLAR_BLACK_BOX_AGENT_PREFIX: 'controller',
            RALLAR_BLACK_BOX_APPLICATION_ID: manifest.group.applicationId,
            RALLAR_BLACK_BOX_WORKSPACE_ID: manifest.group.workspaceId,
            RALLAR_BLACK_BOX_ROOM_ID: manifest.group.groupId,
            RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'headless',
            RALLAR_BLACK_BOX_REGISTER: 'true',
            RALLAR_BLACK_BOX_EXIT_MODE: 'after-target-distributed-run-terminal',
            RALLAR_BLACK_BOX_IDLE_EXIT_MS: String(launch.idleExitMs)
        }
    });
}

/** Ends once every agent of the launch is connected to its control run and registered; the signal is the harness's abort. */
export async function waitForOwnedWorkerAgents(
    worker: ChildProcess,
    launch: OwnedHeadlessWorkerLaunch,
    signal: AbortSignal
): Promise<void> {
    const { services, manifest } = launch;
    await expect.poll(async () => {
        if (worker.exitCode !== null || signal.aborted) {
            throw new Error('Owned worker exited before registration.');
        }
        const snapshot = await readLocalControlRunSnapshot(services.controlBaseUrl, manifest.controlRunId, signal);
        return (snapshot?.agents ?? []).filter((agent) => agent.connected && agent.registeredAtEpochMs !== undefined)
            .map((agent) => agent.agentId).sort();
    }, { timeout: ALL_LOCAL_ALM_REGISTRATION_TIMEOUT_MS, intervals: [1_000] }).toEqual(
        toControllerAgentIds(launch.agentCount)
    );
}

/** Absent while the control server holds no run of that id. */
export async function readLocalControlRunSnapshot(
    controlBaseUrl: string,
    runId: string,
    signal: AbortSignal
): Promise<ControlRunSnapshot | undefined> {
    const response = await fetch(`${controlBaseUrl}/runs/${encodeURIComponent(runId)}`, { signal });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error('Local control snapshot request failed.');
    }
    return decodeControlRunSnapshot(await response.json()).fold(
        () => {
            throw new Error('Local control snapshot could not be decoded.');
        },
        (decoded) => decoded
    );
}

/**
 * A worker whose run reached a terminal state ends by itself, so it is first given time to. Its process group is then
 * signalled either way, which ends a browser the worker left behind.
 */
export async function stopOwnedHeadlessWorker(worker: ChildProcess): Promise<OwnedHeadlessWorkerCleanup> {
    const groupId = worker.pid;
    if (groupId === undefined) {
        return 'not-started';
    }
    const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
    if (worker.exitCode === null && worker.signalCode === null) {
        await waitForCloseWithin(closed, WORKER_EXIT_WAIT_MS);
    }
    const alreadyClosed = worker.exitCode !== null || worker.signalCode !== null;
    try {
        process.kill(-groupId, 'SIGTERM');
    }
    catch {
        if (alreadyClosed) {
            return 'reaped';
        }
    }
    if (!alreadyClosed) {
        const forced = setTimeout(() => {
            try {
                process.kill(-groupId, 'SIGKILL');
            }
            catch {}
        }, WORKER_KILL_AFTER_MS);
        await waitForCloseWithin(closed, WORKER_EXIT_WAIT_MS);
        clearTimeout(forced);
    }
    return worker.exitCode !== null || worker.signalCode !== null ? 'reaped' : 'unreaped';
}

async function waitForCloseWithin(closed: Promise<void>, timeoutMs: number): Promise<void> {
    let ceiling: NodeJS.Timeout | undefined;
    await Promise.race([
        closed,
        new Promise<void>((resolve) => {
            ceiling = setTimeout(resolve, timeoutMs);
        })
    ]);
    clearTimeout(ceiling);
}
