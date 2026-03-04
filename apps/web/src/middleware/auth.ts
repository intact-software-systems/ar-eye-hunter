import {ClientData} from "@shared/api/api-config.ts";

export type AuthSession = {
    readonly clientId: string;
    readonly accessToken: string;
    readonly username: string;
};

const KEY = 'auth.session';

export function readSession(): AuthSession | undefined {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length === 0) return undefined;

    try {
        const s = JSON.parse(raw) as AuthSession;
        if (!s.clientId || !s.accessToken || !s.username) return undefined;
        return s;
    } catch {
        return undefined;
    }
}

export function readSessionAsClientData(): ClientData {
    const session = readSession()
    if (!session) {
        throw new Error('Cannot read session as client data: no session.')
    }

    return {
        clientId: session.clientId,
        sessionId: session.clientId,
    }
}

export function writeSession(session: AuthSession): void {
    localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
    localStorage.removeItem(KEY);
}

export function isLoggedIn(): boolean {
    return readSession() !== undefined;
}