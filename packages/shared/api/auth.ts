import { AuthSession, ClientInfo } from '@shared/api/api-config.ts';

const KEY = 'auth.session';

export type AuthSessionStorageKind = 'local' | 'session';

let authSessionStorageKind: AuthSessionStorageKind = 'local';

function readStorage(): Storage {
    return authSessionStorageKind === 'session'
        ? sessionStorage
        : localStorage;
}

export function configureAuthSessionStorage(kind: AuthSessionStorageKind): void {
    authSessionStorageKind = kind;
}

export function resetAuthSessionStorage(): void {
    authSessionStorageKind = 'local';
}

export function readAuthSessionStorageKind(): AuthSessionStorageKind {
    return authSessionStorageKind;
}

export function readSession(): AuthSession | undefined {
    const storage = readStorage();
    const raw = storage.getItem(KEY);
    if (!raw || raw.length === 0) {
        return undefined;
    }

    try {
        const s = JSON.parse(raw) as AuthSession;
        if (
            !s.clientId ||
            !s.accessToken ||
            !s.username ||
            !s.sessionId ||
            !Number.isFinite(s.expiresAtEpochMs)
        ) {
            return undefined;
        }

        if (s.expiresAtEpochMs <= Date.now()) {
            clearSession();
            return undefined;
        }

        return s;
    }
    catch {
        return undefined;
    }
}

export function readSessionAsClientInfo(): ClientInfo {
    const session = readSession();
    if (!session) {
        throw new Error('Cannot read session as client data: no session.');
    }

    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
}

export function writeSession(session: AuthSession): void {
    readStorage().setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
    readStorage().removeItem(KEY);
}

export function isLoggedIn(): boolean {
    return readSession() !== undefined;
}
