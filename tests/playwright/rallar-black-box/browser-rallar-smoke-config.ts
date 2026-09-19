export type SmokeTransport = 'realtime' | 'messages.rtc';

export interface SmokeRestoredSession {
    readonly clientId: string;
    readonly accessToken: string;
    readonly username: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export type SmokeAgentAuth =
    | { readonly kind: 'login'; readonly username: string; readonly password: string; }
    | { readonly kind: 'restore'; readonly session: SmokeRestoredSession; };

export interface BrowserRallarSmokeConfig {
    readonly apiBaseUrl: string | undefined;
    readonly roomId: string | undefined;
    readonly agentAAuth: SmokeAgentAuth | undefined;
    readonly agentBAuth: SmokeAgentAuth | undefined;
    readonly agentAActor: string | undefined;
    readonly agentBActor: string | undefined;
    readonly messagesRtcTypeId: string;
    readonly messagesRtcTopicId: string;
    readonly register: boolean | 'if-needed' | undefined;
    readonly logoutOnClose: boolean;
    readonly leaveRoomOnClose: boolean | undefined;
}

export function readBrowserRallarSmokeConfig(): BrowserRallarSmokeConfig {
    return {
        apiBaseUrl: readEnvValue('VITE_RALLAR_API_BASE_URL'),
        roomId: readEnvValue('VITE_RALLAR_ROOM_ID'),
        agentAAuth: readAgentAuth('A'),
        agentBAuth: readAgentAuth('B'),
        agentAActor: readFirstEnvValue('VITE_RALLAR_AGENT_A_ACTOR', 'VITE_RALLAR_A_ACTOR'),
        agentBActor: readFirstEnvValue('VITE_RALLAR_AGENT_B_ACTOR', 'VITE_RALLAR_B_ACTOR'),
        messagesRtcTypeId: readFirstEnvValue('VITE_RALLAR_MESSAGES_RTC_TYPE_ID', 'VITE_RALLAR_TYPE_ID') ??
            'manual.type',
        messagesRtcTopicId: readFirstEnvValue('VITE_RALLAR_MESSAGES_RTC_TOPIC_ID', 'VITE_RALLAR_TOPIC_ID') ??
            'manual.topic',
        register: readEnvValue('VITE_RALLAR_REGISTER')?.toLowerCase() === 'if-needed'
            ? 'if-needed'
            : readBooleanEnv('VITE_RALLAR_REGISTER')
            ? true
            : undefined,
        logoutOnClose: readBooleanEnv('VITE_RALLAR_LOGOUT_ON_CLOSE'),
        leaveRoomOnClose: readEnvValue('VITE_RALLAR_LEAVE_ROOM_ON_CLOSE')
            ? readBooleanEnv('VITE_RALLAR_LEAVE_ROOM_ON_CLOSE')
            : undefined
    };
}

function readAgentAuth(prefix: 'A' | 'B'): SmokeAgentAuth | undefined {
    const username = readFirstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        'VITE_RALLAR_USERNAME'
    );
    const password = readFirstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        'VITE_RALLAR_PASSWORD'
    );
    if (username && password) {
        return { kind: 'login', username, password };
    }
    const session = readRestoredSession(prefix);
    return session ? { kind: 'restore', session } : undefined;
}

function readRestoredSession(prefix: 'A' | 'B'): SmokeRestoredSession | undefined {
    const username = readFirstEnvValue(`VITE_RALLAR_AGENT_${prefix}_USERNAME`, `VITE_RALLAR_${prefix}_USERNAME`);
    const accessToken = readFirstEnvValue(`VITE_RALLAR_AGENT_${prefix}_TOKEN`, `VITE_RALLAR_${prefix}_TOKEN`);
    const clientId = readFirstEnvValue(`VITE_RALLAR_AGENT_${prefix}_CLIENT_ID`, `VITE_RALLAR_${prefix}_CLIENT_ID`);
    const sessionId = readFirstEnvValue(`VITE_RALLAR_AGENT_${prefix}_SESSION_ID`, `VITE_RALLAR_${prefix}_SESSION_ID`);
    if (!username || !accessToken || !clientId || !sessionId) {
        return undefined;
    }
    return {
        username,
        accessToken,
        clientId,
        sessionId,
        expiresAtEpochMs: readNumberEnv(`VITE_RALLAR_AGENT_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
            readNumberEnv(`VITE_RALLAR_${prefix}_EXPIRES_AT_EPOCH_MS`) ?? Date.now() + 30 * 60 * 1000
    };
}

function readEnvValue(key: string): string | undefined {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function readFirstEnvValue(...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = readEnvValue(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function readBooleanEnv(key: string): boolean {
    const normalized = readEnvValue(key)?.toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readNumberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
