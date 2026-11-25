import { expect } from '@playwright/test';

import { RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';

import {
    LIFECYCLE_CONNECT_RETRY_INTERVAL_MS,
    LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS,
    LIFECYCLE_DIAL_POLL_TIMEOUT_MS,
    LIFECYCLE_HYDRATION_REFRESH_TIMEOUT_MS,
    LIFECYCLE_LANE_TEARDOWN_POLL_TIMEOUT_MS,
    LIFECYCLE_PRESENCE_SETTLE_MS,
    LIFECYCLE_ROOM_HELD_ATTEMPTS,
    LIFECYCLE_ROOM_HELD_INTERVAL_MS,
    LIFECYCLE_STAGE_WAIT_MS,
    LIFECYCLE_SURVIVOR_REFRESH_TIMEOUT_MS,
    PRESENCE_CONNECT_TIMING
} from './compute-live-rtc-lifecycle-scenario-timeout-ms.ts';
import { MANUAL_TRIGGER_POLICY, type LiveRtcControlPort } from './create-group-formation-lifecycle-driver.ts';
import type { LiveRtcAgentTrio } from './live-rtc-agent-environment.ts';
import type { LiveRtcBrowserAgentConfig, LiveRtcBrowserContextFactory } from './live-rtc-browser-agents.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import type { LiveRtcDeliveryOperations } from './live-rtc-delivery-operations.ts';
import {
    readRestoredSession,
    type FormationAgentInput,
    type FormationHealth,
    type LiveRtcFormationOperations
} from './live-rtc-formation-operations.ts';

/** How long a reset agent's lane teardown poll pauses between its health reads. */
const LIFECYCLE_LANE_TEARDOWN_POLL_INTERVAL_MS = 1_000;

/** How long the dial witness's poll pauses between its reads of the agent's events. */
const LIFECYCLE_DIAL_POLL_INTERVAL_MS = 500;

export namespace LiveRtcLifecycleOperations {
    export interface Config {
        readonly formation: LiveRtcFormationOperations;
        readonly delivery: Pick<LiveRtcDeliveryOperations, 'setupGroupMembership'>;
        readonly apiBaseUrl: string | undefined;
        readonly applicationId: string;
        readonly workspaceId: string;
    }

    export interface Control extends LiveRtcControlPort, Pick<LiveRtcControlClient, 'fetchRun'> {}

    /** One scenario's trio on its own managed group; a reopened member replaces its predecessor in `agents`. */
    export interface Run {
        readonly control: Control;
        readonly runId: string;
        readonly groupId: string;
        readonly suffix: string;
        agents: LiveRtcAgentTrio;
    }

    export interface ReopenInput {
        readonly browser: LiveRtcBrowserContextFactory;
        readonly config: LiveRtcBrowserAgentConfig;
        readonly index: 0 | 1 | 2;
    }
}

/**
 * The bounded steps the lifecycle acceptance scenarios compose, each one a building block their timeout derivation
 * sums.
 */
export class LiveRtcLifecycleOperations {
    readonly #config: LiveRtcLifecycleOperations.Config;

    constructor(config: LiveRtcLifecycleOperations.Config) {
        this.#config = config;
    }

    toAgentInput(run: LiveRtcLifecycleOperations.Run, agent: LiveRtcControlClient.Agent): FormationAgentInput {
        const { applicationId, workspaceId } = this.#config;
        return {
            control: run.control,
            runId: run.runId,
            agent,
            roomRef: { applicationId, workspaceId, groupId: run.groupId },
            suffix: run.suffix
        };
    }

    /** The group every scenario runs on: managed, with the driver commanding each boundary itself, then every presence. */
    async connectTrioPresence(run: LiveRtcLifecycleOperations.Run): Promise<void> {
        await this.#config.delivery.setupGroupMembership({
            control: run.control,
            runId: run.runId,
            owner: run.agents[0],
            members: run.agents,
            groupId: run.groupId,
            suffix: run.suffix,
            lifecyclePolicy: MANUAL_TRIGGER_POLICY
        });
        for (const agent of run.agents) {
            await this.connectPresence(run, agent);
        }
    }

    /**
     * Presence without a readiness barrier: the browser connects, joins and hydrates on its own, which is the entry
     * every observing agent uses so nothing refreshes the room on its behalf. The client polls for the result for the
     * connect's own budget.
     */
    async connectPresence(run: LiveRtcLifecycleOperations.Run, agent: LiveRtcControlClient.Agent): Promise<void> {
        const { applicationId, workspaceId, apiBaseUrl } = this.#config;
        const commandId = this.#config.formation.createCommandId(this.toAgentInput(run, agent), 'presence');
        // The accepted layout names this stored session, not the opener's agent ID.
        const expectedSessionId = (await readRestoredSession(agent)).sessionId;
        const result = await run.control.executeOk({
            runId: run.runId,
            agentId: agent.agentId,
            commandId,
            command: {
                ...PRESENCE_CONNECT_TIMING,
                commandId,
                connection: agent.connection,
                actor: agent.actor,
                roomId: run.groupId,
                applicationId,
                workspaceId,
                roomRef: { applicationId, workspaceId, groupId: run.groupId },
                transport: 'realtime',
                rallar: {
                    apiBaseUrl: apiBaseUrl ?? '',
                    expectedSessionId,
                    // Restore the stored session; credentials would mint a different layout peer.
                    // Closing a page preserves its session and membership for the reopening test.
                    logoutOnClose: false,
                    leaveRoomOnClose: false,
                    timeoutMs: RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS
                }
            }
        });
        // A new session would test admission instead of restoring an accepted peer.
        expect(
            run.control.requireSessionId(result, commandId),
            `Agent ${agent.prefix} connected as a different session than the one its page holds`
        ).toBe(expectedSessionId);
    }

    /** Drives the group to the active lifecycle stage; transport readiness is a separate barrier. */
    async activateGroup(run: LiveRtcLifecycleOperations.Run): Promise<void> {
        await this.connectTrioPresence(run);
        // Presence is what the planner plans over, and it propagates asynchronously; planning before it
        // settles yields a cycle with nothing to publish, so the group never gains a planned layout.
        await run.agents[0].page.waitForTimeout(LIFECYCLE_PRESENCE_SETTLE_MS);
        // `readiness` is an after-activation instrument: the room's transport state is derived from the
        // ACCEPTED layout, which the promotion at `activate` creates, so before that it reads `idle` and
        // the barrier can never resolve. The dials are therefore awaited by their own evidence here, and
        // readiness is used only once the group is active.
        await this.#command(run, 'plan');
        await this.connectWhenPlanned(run);
        for (const agent of run.agents) {
            await this.expectDialed(run, agent, 1);
        }
        await this.#command(run, 'activate');
    }

    /** Reopens a member with its restored session in place of the one it replaces in the run's trio. */
    async reopen(
        run: LiveRtcLifecycleOperations.Run,
        input: LiveRtcLifecycleOperations.ReopenInput
    ): Promise<LiveRtcControlClient.Agent> {
        const reopened = await this.#config.formation.reopen({
            ...this.toAgentInput(run, run.agents[input.index]),
            browser: input.browser,
            config: input.config,
            transport: 'realtime'
        });
        const [a, b, c] = run.agents.map((agent, index) => index === input.index ? reopened : agent);
        run.agents = [a, b, c];
        return reopened;
    }

    /**
     * A member that reopens returns to a mesh whose surviving peers still hold the lane it left with, so they must
     * reconcile those lanes before the reopened member waits for readiness.
     */
    async settleSurvivors(run: LiveRtcLifecycleOperations.Run, reopened: LiveRtcControlClient.Agent): Promise<void> {
        for (const agent of run.agents) {
            if (agent.agentId !== reopened.agentId) {
                await agent.refreshRoom({ refresh: 'always', timeoutMs: LIFECYCLE_SURVIVOR_REFRESH_TIMEOUT_MS });
            }
        }
    }

    /**
     * A reopened page must hold the room before anything it reports means anything. The health decoder fails with the
     * whole block when the formation summary is missing, so a page that connected but never took the room says so here
     * rather than inside a readiness timeout.
     */
    async expectRoomHeld(run: LiveRtcLifecycleOperations.Run, agent: LiveRtcControlClient.Agent): Promise<void> {
        let lastFailure = 'the room was never read';
        for (let attempt = 0; attempt < LIFECYCLE_ROOM_HELD_ATTEMPTS; attempt++) {
            try {
                await this.#config.formation.health(this.toAgentInput(run, agent));
                return;
            }
            catch (error) {
                lastFailure = error instanceof Error ? error.message : String(error);
            }
            await agent.page.waitForTimeout(LIFECYCLE_ROOM_HELD_INTERVAL_MS);
        }
        throw new Error(`Agent ${agent.prefix} reopened without taking the room. ${lastFailure}`);
    }

    /**
     * The planned layout is published by the topology worker, not by the `plan` receipt, so a `connect` issued straight
     * after `plan` can be refused for naming no planned layout. The browser's own cached planned slot is not the gate
     * either — it is delivered on its own schedule and a manager that never subscribed may not hold it at all — so the
     * owner's connect is retried on exactly that refusal, which is what the shipped quickstart tells an application to
     * do.
     */
    async connectWhenPlanned(run: LiveRtcLifecycleOperations.Run): Promise<void> {
        const owner = run.agents[0];
        const deadline = Date.now() + LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS;
        let lastError = 'the connect was never attempted';
        while (Date.now() < deadline) {
            const result = await this.#config.formation.tryCommand({
                ...this.toAgentInput(run, owner),
                input: { command: 'connect' }
            });
            if (result.ok) {
                return;
            }
            lastError = JSON.stringify(result.error);
            if (!lastError.includes('no planned layout')) {
                break;
            }
            await owner.page.waitForTimeout(LIFECYCLE_CONNECT_RETRY_INTERVAL_MS);
        }
        throw new Error(`The connect never found a published layout: ${lastError}`);
    }

    /** The dial witness the two positive controls assert: the agent's own recorded peer-created events. */
    async expectDialed(
        run: LiveRtcLifecycleOperations.Run,
        agent: LiveRtcControlClient.Agent,
        atLeast: number
    ): Promise<void> {
        await expect
            .poll(async () => await this.#config.formation.countPeerCreated(this.toAgentInput(run, agent)), {
                timeout: LIFECYCLE_DIAL_POLL_TIMEOUT_MS,
                intervals: [LIFECYCLE_DIAL_POLL_INTERVAL_MS]
            })
            .toBeGreaterThanOrEqual(atLeast);
    }

    /**
     * The owner resets the group, then each member waits for the dormant stage and for its lanes to close, and returns
     * the health it then reads. The stage reaches `dormant` before the lanes finish closing, so the teardown is awaited
     * rather than sampled: what the pin claims is that they end empty, not that they are empty the instant the stage
     * changes.
     */
    async resetTrioToDormant(run: LiveRtcLifecycleOperations.Run): Promise<readonly FormationHealth[]> {
        const resetAt = Date.now();
        await this.#command(run, 'reset');
        const healths: FormationHealth[] = [];
        for (const agent of run.agents) {
            await this.#waitForDormant(run, agent, resetAt);
            await expect
                .poll(async () => countLanes(await this.#config.formation.health(this.toAgentInput(run, agent))), {
                    timeout: LIFECYCLE_LANE_TEARDOWN_POLL_TIMEOUT_MS,
                    intervals: [LIFECYCLE_LANE_TEARDOWN_POLL_INTERVAL_MS]
                })
                .toBe(0);
            healths.push(await this.#config.formation.health(this.toAgentInput(run, agent)));
        }
        return healths;
    }

    /** The owner resets the group and waits for its own dormant stage. */
    async resetOwnerToDormant(run: LiveRtcLifecycleOperations.Run): Promise<void> {
        const resetAt = Date.now();
        await this.#command(run, 'reset');
        await this.#waitForDormant(run, run.agents[0], resetAt);
    }

    /** The owner starts the next series and plans it, then its connect dials each member past its count before. */
    async redial(run: LiveRtcLifecycleOperations.Run, dialedBefore: readonly number[]): Promise<void> {
        for (const command of ['start', 'plan'] as const) {
            await this.#command(run, command);
        }
        await this.connectWhenPlanned(run);
        for (const [index, agent] of run.agents.entries()) {
            await this.expectDialed(run, agent, (dialedBefore[index] ?? 0) + 1);
        }
    }

    /** A reopened member's health as it hydrated, then its health after it refreshes its room. */
    async readHydratedHealths(
        run: LiveRtcLifecycleOperations.Run,
        reopened: LiveRtcControlClient.Agent
    ): Promise<readonly [FormationHealth, FormationHealth]> {
        const hydrated = await this.#config.formation.health(this.toAgentInput(run, reopened));
        await reopened.refreshRoom({ refresh: 'always', timeoutMs: LIFECYCLE_HYDRATION_REFRESH_TIMEOUT_MS });
        return [hydrated, await this.#config.formation.health(this.toAgentInput(run, reopened))];
    }

    async #command(
        run: LiveRtcLifecycleOperations.Run,
        command: 'plan' | 'activate' | 'reset' | 'start'
    ): Promise<void> {
        await this.#config.formation.command({ ...this.toAgentInput(run, run.agents[0]), input: { command } });
    }

    async #waitForDormant(
        run: LiveRtcLifecycleOperations.Run,
        agent: LiveRtcControlClient.Agent,
        sinceEpochMs: number
    ): Promise<void> {
        await this.#config.formation.waitForStage({
            ...this.toAgentInput(run, agent),
            stage: 'dormant',
            timeoutMs: LIFECYCLE_STAGE_WAIT_MS,
            sinceEpochMs
        });
    }
}

/** Every lane a member's RTC status still names. */
function countLanes(health: FormationHealth): number {
    return [
        ...health.rtcStatus.activePeerIds,
        ...health.rtcStatus.knownPeerIds,
        ...health.rtcStatus.readyPeerIds
    ].length;
}
