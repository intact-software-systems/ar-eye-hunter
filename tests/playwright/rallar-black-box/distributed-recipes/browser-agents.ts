import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page
} from '@playwright/test';

import { computeCommandResultWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-agent-opening-timeout-ms.ts';
import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlCommandEnvelope,
    type ControlRegisterEnvelope,
    type ControlResultEnvelope
} from '../../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import { type RallarBlackBoxDistributedGroupRef } from '../../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { createRallarBlackBoxEnsureGroupRequestId } from '../../../../packages/shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '../../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { AuthSession } from '../../../../packages/shared/api/api-config.ts';

import {
    FULL_STACK_CONTROL_WS_URL,
    FULL_STACK_SPA_ORIGIN,
    readFullStackConfig
} from '../full-stack-helpers.ts';
import { RESTORED_SESSION_LIFETIME_MS } from '../restored-session-lifetime-ms.ts';
import { executeOk } from './distributed-control.ts';

type ProviderUnderTest = 'simulated' | 'browser-rallar';

type AgentPrefix = 'A' | 'B' | 'C';

type AgentAuth =
    | Readonly<{
        kind: 'login';
        username: string;
        password: string;
    }>
    | Readonly<{
        kind: 'restore';
        session: AuthSession;
    }>;

export interface AgentHandle {
    readonly context: BrowserContext;
    readonly page: Page;
    readonly prefix: AgentPrefix;
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
}

interface OpenControlAgentInput {
    readonly provider: ProviderUnderTest;
    readonly prefix: AgentPrefix;
    readonly runId: string;
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly auth?: AgentAuth;
}

interface OpenScriptedControlAgentInput {
    readonly runId: string;
    readonly agentId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly providerMode: string;
    readonly onCommand?: (command: ControlCommandEnvelope) => ControlResultEnvelope;
}

interface ConfigureAgentForDistributedGroupInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agent: AgentHandle;
    readonly provider: ProviderUnderTest;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly suffix: string;
}

interface ConfigureAgentsForDistributedGroupInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly handles: readonly AgentHandle[];
    readonly provider: ProviderUnderTest;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly suffix: string;
}

interface ScriptedControlResultInput {
    readonly runId: string;
    readonly agentId: string;
    readonly command: ControlCommandEnvelope;
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly errorMessage?: string;
}

interface SetupGroupMembershipInput {
    readonly owner: AgentHandle;
    readonly members: readonly AgentHandle[];
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly suffix: string;
}

export const config = readFullStackConfig();

/** Opening a control agent waits for its Advanced tab, then for its registration. */
export const CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS = 2 * CONTROL_AGENT_OPENING_TIMEOUT_MS;

/** How long a control agent's configuration for the distributed group is polled for its result. */
export const DISTRIBUTED_AGENT_CONFIGURE_RESULT_WAIT_MS = 20_000;

/** Each group creation or membership request's own budget. */
export const DISTRIBUTED_GROUP_REQUEST_TIMEOUT_MS = 15_000;

/** How long a command with a budget of its own is polled for its result once that budget is spent. */
const DISTRIBUTED_COMMAND_RESULT_POLL_MARGIN_MS = 30_000;

/** How long a group creation or membership request is polled for its result: its budget, then the poll margin. */
export const DISTRIBUTED_GROUP_REQUEST_RESULT_WAIT_MS = DISTRIBUTED_GROUP_REQUEST_TIMEOUT_MS +
    DISTRIBUTED_COMMAND_RESULT_POLL_MARGIN_MS;

/** How long a scripted control agent reports each of its commands took. */
const SCRIPTED_RESULT_DURATION_MS = 1;

/** How long a scripted control agent's WebSocket may take to open. */
export const SCRIPTED_CONTROL_AGENT_OPEN_TIMEOUT_MS = 10_000;

const liveDistributedEnabled = booleanEnv('RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES') ||
    booleanEnv('RALLAR_BLACK_BOX_LIVE_DISTRIBUTED_RECIPES');

const liveAgentAAuth = readLiveAgentAuth('A');

const liveAgentBAuth = readLiveAgentAuth('B');

const liveAgentCAuth = readLiveAgentAuth('C');

export const hasLiveDistributedConfig = Boolean(
    config.enabled &&
        liveDistributedEnabled &&
        envValue('VITE_RALLAR_API_BASE_URL') &&
        liveAgentAAuth &&
        liveAgentBAuth &&
        liveAgentCAuth
);

function envValue(key: string): string | undefined {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function firstEnvValue(...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envValue(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function booleanEnv(key: string): boolean {
    const normalized = envValue(key)?.toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function numberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function readLiveAgentAuth(prefix: AgentPrefix): AgentAuth | undefined {
    const fallbackUser = prefix === 'A'
        ? config.userA
        : prefix === 'B'
        ? config.userB
        : config.userC;
    const genericUsername = prefix === 'A' ? ['VITE_RALLAR_USERNAME'] : [];
    const genericPassword = prefix === 'A' ? ['VITE_RALLAR_PASSWORD'] : [];
    const configuredUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        ...genericUsername
    );
    const configuredPassword = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        ...genericPassword
    );
    const username = configuredUsername ??
        fallbackUser.username;
    const password = configuredPassword ??
        fallbackUser.password;
    if (username && password) {
        return {
            kind: 'login',
            username,
            password
        };
    }

    return readRestoredAgentAuth(prefix);
}

function readRestoredAgentAuth(prefix: AgentPrefix): AgentAuth | undefined {
    const restoreUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`
    );
    const token = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_TOKEN`,
        `VITE_RALLAR_${prefix}_TOKEN`
    );
    const clientId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_CLIENT_ID`,
        `VITE_RALLAR_${prefix}_CLIENT_ID`
    );
    const sessionId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_SESSION_ID`,
        `VITE_RALLAR_${prefix}_SESSION_ID`
    );
    if (!restoreUsername || !token || !clientId || !sessionId) {
        return undefined;
    }

    return {
        kind: 'restore',
        session: {
            clientId,
            accessToken: token,
            username: restoreUsername,
            sessionId,
            expiresAtEpochMs: numberEnv(`VITE_RALLAR_AGENT_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                numberEnv(`VITE_RALLAR_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                Date.now() + RESTORED_SESSION_LIFETIME_MS
        }
    };
}

export function agentAuth(prefix: AgentPrefix): AgentAuth {
    const auth = prefix === 'A' ? liveAgentAAuth : prefix === 'B' ? liveAgentBAuth : liveAgentCAuth;
    if (!auth) {
        throw new Error(`Missing live auth for agent ${prefix}.`);
    }
    return auth;
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

export async function openControlAgent(
    browser: Browser,
    input: OpenControlAgentInput
): Promise<AgentHandle> {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();

        if (input.auth?.kind === 'restore') {
            await page.addInitScript((session) => {
                window.localStorage.setItem('auth.session', JSON.stringify(session));
            }, input.auth.session);
        }

        const query = toControlAgentQuery(input);

        await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
        if (input.auth?.kind === 'login') {
            await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible({
                timeout: CONTROL_AGENT_OPENING_TIMEOUT_MS
            });
            await page.getByRole('button', { name: 'Sign in' }).click();
        }
        await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute(
            'aria-selected',
            'true',
            { timeout: CONTROL_AGENT_OPENING_TIMEOUT_MS }
        );
        await expect(page.locator('#panel-local-workbench .control-panel'))
            .toContainText('registered', { timeout: CONTROL_AGENT_OPENING_TIMEOUT_MS });

        return {
            context,
            page,
            prefix: input.prefix,
            agentId: input.agentId,
            actor: input.actor,
            connection: input.connection
        };
    }
    catch (error) {
        try {
            await context.close();
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Browser agent acquisition and cleanup failed.');
        }
        throw error;
    }
}

export async function openScriptedControlAgent(
    input: OpenScriptedControlAgentInput
): Promise<WebSocket> {
    const socket = new WebSocket(FULL_STACK_CONTROL_WS_URL);
    socket.addEventListener('message', (event) => {
        const envelope = parseControlServerMessage(String(event.data), input);
        if (!envelope.ok) {
            return;
        }
        const response = input.onCommand?.(envelope.envelope);
        if (response !== undefined && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
        }
    });
    await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;

        function cleanup() {
            clearTimeout(timeout);
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('error', handleError);
        }

        function handleOpen() {
            socket.send(JSON.stringify(toScriptedRegistration(input, Date.now())));
            cleanup();
            resolve();
        }

        function handleError() {
            cleanup();
            reject(new Error(`Scripted control agent ${input.agentId} WebSocket failed.`));
        }

        timeout = setTimeout(() => {
            cleanup();
            socket.close();
            reject(new Error(`Scripted control agent ${input.agentId} did not open.`));
        }, SCRIPTED_CONTROL_AGENT_OPEN_TIMEOUT_MS);
        socket.addEventListener('open', handleOpen);
        socket.addEventListener('error', handleError);
    });
    return socket;
}

export function scriptedControlResult(
    input: ScriptedControlResultInput
): ControlResultEnvelope {
    const now = Date.now();
    const error = input.ok
        ? undefined
        : {
            code: input.errorCode ?? 'SCRIPTED_CONTROL_FAILURE',
            message: input.errorMessage ?? 'Scripted control-agent failure.'
        };
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: input.runId,
        agentId: input.agentId,
        commandId: input.command.commandId,
        ok: input.ok,
        result: {
            commandId: input.command.commandId,
            kind: input.command.command.kind,
            status: input.ok ? 'ok' : 'failed',
            ok: input.ok,
            startedAtEpochMs: now,
            endedAtEpochMs: now + SCRIPTED_RESULT_DURATION_MS,
            durationMs: SCRIPTED_RESULT_DURATION_MS,
            value: {
                scripted: true,
                commandKind: input.command.command.kind
            },
            error
        },
        error
    };
}

async function configureAgentForDistributedGroup(input: ConfigureAgentForDistributedGroupInput): Promise<void> {
    const { request, runId, agent, provider, group, suffix } = input;

    await executeOk({
        request,
        runId,
        agentId: agent.agentId,
        commandId: `configure-distributed-${agent.prefix.toLowerCase()}-${suffix}`,
        command: {
            kind: 'configure',
            config: {
                runId,
                agentId: agent.agentId,
                apiBaseUrl: config.apiBaseUrl,
                actor: agent.actor,
                sessionId: agent.agentId,
                roomId: group.groupId,
                control: {
                    mode: 'distributed-recipes',
                    providerMode: provider
                },
                defaults: {
                    connection: agent.connection,
                    providerMode: provider,
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                    groupId: group.groupId
                },
                rallar: {
                    apiBaseUrl: config.apiBaseUrl,
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                    groupId: group.groupId,
                    roomRef: group,
                    scope: {
                        applicationId: group.applicationId,
                        workspaceId: group.workspaceId
                    },
                    restoreSession: true,
                    logoutOnClose: false,
                    leaveRoomOnClose: false
                }
            }
        },
        timeout: DISTRIBUTED_AGENT_CONFIGURE_RESULT_WAIT_MS
    });
}

export async function configureAgentsForDistributedGroup(
    input: ConfigureAgentsForDistributedGroupInput
): Promise<void> {
    const { request, runId, handles, provider, group, suffix } = input;

    for (const handle of handles) {
        await configureAgentForDistributedGroup({ request, runId, agent: handle, provider, group, suffix });
    }
}

export async function setupGroupMembership(
    request: APIRequestContext,
    runId: string,
    input: SetupGroupMembershipInput
): Promise<void> {
    await createDistributedGroup(request, runId, input);
    const groupSegment = pathSegment(input.group.groupId);
    for (const member of input.members) {
        const command: RallarBlackBoxTestCommand = {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${pathSegment(input.group.applicationId)}/workspaces/${
                    pathSegment(input.group.workspaceId)
                }/groups/${groupSegment}/members/{auth.clientId}/requests/${crypto.randomUUID()}`,
                method: 'PUT',
                body: {
                    status: 'active'
                }
            },
            response: {
                body: 'json'
            },
            timeoutMs: DISTRIBUTED_GROUP_REQUEST_TIMEOUT_MS
        };
        const joinResult = await executeOk({
            request,
            runId,
            agentId: member.agentId,
            commandId: `group-join-${member.agentId}-${input.suffix}`,
            command,
            timeout: computeCommandResultWaitMs(command, DISTRIBUTED_COMMAND_RESULT_POLL_MARGIN_MS)
        });
        expect(Number(decodeRecord(joinResult.result?.value).status)).toBeLessThan(400);
    }
}

function toControlAgentQuery(input: OpenControlAgentInput): URLSearchParams {
    return new URLSearchParams({
        mode: 'control',
        workspace: 'black-box-runner',
        tab: 'local-workbench',
        provider: input.provider,
        autoConnect: '1',
        controlUrl: FULL_STACK_CONTROL_WS_URL,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: config.apiBaseUrl,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomId: input.group.groupId,
        actor: input.actor,
        sessionId: input.agentId,
        heartbeatIntervalMs: '250',
        statsIntervalMs: '1000',
        rallarLeaveRoomOnClose: '0',
        ...(input.auth?.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
        ...(input.auth?.kind === 'login'
            ? {
                rallarUsername: input.auth.username,
                rallarPassword: input.auth.password
            }
            : {})
    });
}

function toScriptedRegistration(input: OpenScriptedControlAgentInput, now: number): ControlRegisterEnvelope {
    return {
        kind: 'register',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: input.runId,
        agentId: input.agentId,
        atEpochMs: now,
        identity: {
            principalId: input.agentId,
            clientId: input.agentId,
            username: input.agentId,
            sessionId: input.agentId,
            clientInstanceId: input.agentId,
            applicationId: input.group.applicationId,
            workspaceId: input.group.workspaceId,
            groupId: input.group.groupId,
            providerMode: input.providerMode,
            browserLabel: input.agentId,
            sessionLabel: input.agentId,
            updatedAtEpochMs: now
        },
        resume: {
            completedCommandIds: []
        }
    };
}

async function createDistributedGroup(
    request: APIRequestContext,
    runId: string,
    input: SetupGroupMembershipInput
): Promise<void> {
    const command = toGroupCreationCommand(input);
    const createResult = await executeOk({
        request,
        runId,
        agentId: input.owner.agentId,
        commandId: `group-create-${input.suffix}`,
        command,
        timeout: computeCommandResultWaitMs(command, DISTRIBUTED_COMMAND_RESULT_POLL_MARGIN_MS)
    });
    expect(Number(decodeRecord(createResult.result?.value).status)).toBe(201);
}

function toGroupCreationCommand(input: SetupGroupMembershipInput): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${pathSegment(input.group.applicationId)}/workspaces/${
                pathSegment(input.group.workspaceId)
            }/groups/requests/${
                createRallarBlackBoxEnsureGroupRequestId({
                    requestPrefix: 'rtc-realtime',
                    group: input.group
                })
            }`,
            method: 'POST',
            body: {
                groupId: input.group.groupId,
                displayName: input.group.groupId,
                description: 'Created by rallar-black-box distributed recipe QA',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: '{auth.clientId}',
                metadata: {
                    source: 'rallar-black-box',
                    matrix: 'distributed-recipes',
                    suffix: input.suffix
                }
            }
        },
        response: {
            body: 'json'
        },
        timeoutMs: DISTRIBUTED_GROUP_REQUEST_TIMEOUT_MS
    };
}
