import { toError } from '@shared/resilience/to-error.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    readFullStackControlBaseUrl,
    toFullStackControlWebSocketUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import {
    closeLiveRtcBrowserAgentContexts,
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentAuth,
    type LiveRtcBrowserContextFactory
} from './live-rtc-browser-agents.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import type { AgentPrefix } from './live-rtc-delivery-operations.ts';

export const SPA_BASE_URL = envValue('VITE_RALLAR_SPA_BASE_URL') ?? 'http://localhost:5176';
export const CONTROL_BASE_URL = readFullStackControlBaseUrl();
export const CONTROL_WS_URL = toFullStackControlWebSocketUrl(CONTROL_BASE_URL);

export const apiBaseUrl = envValue('VITE_RALLAR_API_BASE_URL');
export const roomSeed = firstEnvValue('VITE_RALLAR_ROOM_ID', 'VITE_RALLAR_GROUP_ID');
export const applicationId = envValue('VITE_RALLAR_APPLICATION_ID') ?? 'ar-eye-hunter';
export const workspaceId = envValue('VITE_RALLAR_WORKSPACE_ID') ?? 'default';
export const rtcCaptureMode: RtcSignalingDiagnostics.CaptureMode | undefined = parseRtcCaptureMode(
    process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE
).fold(
    (issues) => {
        throw new Error(issues.map((issue) => issue.message).join(' '));
    },
    (parsed) => parsed.mode
);

export const fullStackEnabled = booleanEnv('RALLAR_BLACK_BOX_FULL_STACK');
export const liveMatrixEnabled = booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_MATRIX');

const agentAAuth = readLiveRtcBrowserAgentAuth('A');
const agentBAuth = readLiveRtcBrowserAgentAuth('B');
const agentCAuth = readLiveRtcBrowserAgentAuth('C');

export const hasThreeAgentConfig = Boolean(
    fullStackEnabled && liveMatrixEnabled && apiBaseUrl && agentAAuth && agentBAuth && agentCAuth
);

export const LIVE_RTC_SKIP_MESSAGE =
    'Live RTC three-browser scenarios require RALLAR_BLACK_BOX_FULL_STACK=1, RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1, an API base URL and three agent credentials.';

export function readLiveRtcClusterApiOrigins(): readonly string[] | undefined {
    if (!booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER')) {
        return undefined;
    }
    const urls = readLiveRtcAgentApiUrls(apiBaseUrl);
    return [urls.A, urls.B, urls.C].map((url) => new URL(url).origin);
}

export function readLiveRtcAgentApiUrls(baseApiUrl: string | undefined): Readonly<Record<AgentPrefix, string>> {
    if (!baseApiUrl) {
        throw new Error('Live RTC browser agents require an API base URL.');
    }
    if (!booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER')) {
        return { A: baseApiUrl, B: baseApiUrl, C: baseApiUrl };
    }
    const B = envValue('VITE_RALLAR_API_BASE_URL_B');
    const C = envValue('VITE_RALLAR_API_BASE_URL_C');
    if (!B || !C) {
        throw new Error('RTC cluster proof requires API origins for A, B, and C.');
    }
    const urls = { A: baseApiUrl, B, C };
    const origins = [urls.A, urls.B, urls.C].map((url) => new URL(url).origin);
    if (new Set(origins).size !== 3) {
        throw new Error('RTC cluster proof requires three distinct API origins.');
    }
    return urls;
}

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

export function readLiveRtcBrowserAgentAuth(prefix: AgentPrefix): LiveRtcBrowserAgentAuth | undefined {
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
        apiBaseUrl: readLiveRtcAgentApiUrls(apiBaseUrl).A,
        register: booleanEnv('VITE_RALLAR_REGISTER')
    };
}

export async function openAgentTrio(
    browser: LiveRtcBrowserContextFactory,
    input: OpenAgentTrioInput
): Promise<LiveRtcAgentTrio> {
    const handles: LiveRtcControlClient.Agent[] = [];
    try {
        const agentApiUrls = readLiveRtcAgentApiUrls(apiBaseUrl);
        const config = liveRtcAgentConfig();
        for (const prefix of ['A', 'B', 'C'] as const) {
            const agentName = `${input.label}-${prefix.toLowerCase()}-${input.suffix}`;
            handles.push(
                await openLiveRtcBrowserAgent(browser, {
                    config: {
                        ...config,
                        apiBaseUrl: agentApiUrls[prefix]
                    },
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
