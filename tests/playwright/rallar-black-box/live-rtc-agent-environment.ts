import { toError } from '@shared/resilience/to-error.ts';

import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentAuth,
    type LiveRtcBrowserContextFactory
} from './live-rtc-browser-agents.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import type { AgentPrefix } from './live-rtc-delivery-operations.ts';

/**
 * The environment every live three-browser spec reads and the trio it opens. Extracted so the
 * lifecycle acceptance spec and the matrix spec resolve the same variables from one place rather
 * than each carrying its own copy of the fallback chains.
 */

export const SPA_BASE_URL = envValue('VITE_RALLAR_SPA_BASE_URL') ?? 'http://localhost:5176';
export const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
export const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

export const apiBaseUrl = envValue('VITE_RALLAR_API_BASE_URL');
export const roomSeed = firstEnvValue('VITE_RALLAR_ROOM_ID', 'VITE_RALLAR_GROUP_ID');
export const applicationId = envValue('VITE_RALLAR_APPLICATION_ID') ?? 'ar-eye-hunter';
export const workspaceId = envValue('VITE_RALLAR_WORKSPACE_ID') ?? 'default';

export const fullStackEnabled = booleanEnv('RALLAR_BLACK_BOX_FULL_STACK');
export const liveMatrixEnabled = booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_MATRIX');

const agentAAuth = resolveLiveRtcBrowserAgentAuth('A');
const agentBAuth = resolveLiveRtcBrowserAgentAuth('B');
const agentCAuth = resolveLiveRtcBrowserAgentAuth('C');

export const hasThreeAgentConfig = Boolean(
    fullStackEnabled && liveMatrixEnabled && apiBaseUrl && agentAAuth && agentBAuth && agentCAuth
);

export const LIVE_RTC_SKIP_MESSAGE =
    'Live RTC three-browser scenarios require RALLAR_BLACK_BOX_FULL_STACK=1, RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1, an API base URL and three agent credentials.';

export function envValue(key: string): string | undefined {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

export function rawEnvironmentValue(key: string): string | null {
    return process.env[key] ?? null;
}

export function firstEnvValue(...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envValue(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

export function booleanEnv(key: string): boolean {
    const normalized = envValue(key)?.toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function numberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveLiveRtcBrowserAgentAuth(prefix: AgentPrefix): LiveRtcBrowserAgentAuth | undefined {
    const genericUsername = prefix === 'A' ? ['VITE_RALLAR_USERNAME'] : [];
    const genericPassword = prefix === 'A' ? ['VITE_RALLAR_PASSWORD'] : [];
    const username = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        ...genericUsername
    );
    const password = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        ...genericPassword
    );
    if (username && password) {
        return {
            kind: 'login',
            username,
            password
        };
    }

    const restoreUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`
    );
    const token = firstEnvValue(`VITE_RALLAR_AGENT_${prefix}_TOKEN`, `VITE_RALLAR_${prefix}_TOKEN`);
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
                Date.now() + 30 * 60 * 1000
        }
    };
}

export function agentAuth(prefix: AgentPrefix): LiveRtcBrowserAgentAuth {
    const auth = prefix === 'A' ? agentAAuth : prefix === 'B' ? agentBAuth : agentCAuth;
    if (!auth) {
        throw new Error(`Missing auth for agent ${prefix}.`);
    }
    return auth;
}

/**
 * The credentials the agent's page was opened with, when it was opened by logging in. A page opened
 * by restoring a session has no login of its own, so a command that must authenticate carries these.
 */
export function agentCredentials(
    prefix: AgentPrefix
): Readonly<{ username: string; password: string; }> | undefined {
    const auth = prefix === 'A' ? agentAAuth : prefix === 'B' ? agentBAuth : agentCAuth;
    return auth?.kind === 'login' ? { username: auth.username, password: auth.password } : undefined;
}

export function actorFor(prefix: AgentPrefix, suffix: string): string {
    return firstEnvValue(`VITE_RALLAR_AGENT_${prefix}_ACTOR`, `VITE_RALLAR_${prefix}_ACTOR`) ??
        `agent-${prefix.toLowerCase()}-${suffix}`;
}

export interface OpenAgentTrioInput {
    readonly runId: string;
    readonly groupId: string;
    readonly suffix: string;
    readonly label: string;
}

export type LiveRtcAgentTrio = readonly [
    LiveRtcControlClient.Agent,
    LiveRtcControlClient.Agent,
    LiveRtcControlClient.Agent
];

export function liveRtcAgentConfig(): Parameters<typeof openLiveRtcBrowserAgent>[1]['config'] {
    return {
        spaBaseUrl: SPA_BASE_URL,
        controlWsUrl: CONTROL_WS_URL,
        apiBaseUrl: apiBaseUrl ?? '',
        register: booleanEnv('VITE_RALLAR_REGISTER')
    };
}

export async function openAgentTrio(
    browser: LiveRtcBrowserContextFactory,
    input: OpenAgentTrioInput
): Promise<LiveRtcAgentTrio> {
    const handles: LiveRtcControlClient.Agent[] = [];
    try {
        for (const prefix of ['A', 'B', 'C'] as const) {
            const agentName = `${input.label}-${prefix.toLowerCase()}-${input.suffix}`;
            handles.push(
                await openLiveRtcBrowserAgent(browser, {
                    config: liveRtcAgentConfig(),
                    prefix,
                    auth: agentAuth(prefix),
                    runId: input.runId,
                    agentId: agentName,
                    actor: actorFor(prefix, input.suffix),
                    connection: agentName,
                    groupId: input.groupId
                })
            );
        }
        const [a, b, c] = handles;
        if (!a || !b || !c) {
            throw new Error('Three live RTC browser agents were not opened.');
        }
        return [a, b, c];
    }
    catch (error) {
        await closeLiveRtcBrowserAgentContexts(handles);
        throw toError(error);
    }
}
