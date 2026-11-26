import { AuthSession, ClientInfo } from '@shared/api/api-config.ts';

const KEY = 'auth.session';

export type AuthSessionStorageKind = 'local' | 'session' | 'memory';

let configuredStorageKind: AuthSessionStorageKind = 'local';
let activeStorageKind: AuthSessionStorageKind = 'local';
let memorySession: AuthSession | undefined;

function readStorage(): Storage {
    return activeStorageKind === 'session'
        ? sessionStorage
        : localStorage;
}

export function configureAuthSessionStorage(kind: AuthSessionStorageKind): void {
    configuredStorageKind = kind;
    activeStorageKind = kind;
    memorySession = undefined;
}

export function resetAuthSessionStorage(): void {
    configureAuthSessionStorage('local');
}

export function readAuthSessionStorageKind(): AuthSessionStorageKind {
    return activeStorageKind;
}

/** Expiry is not judged here: only a calibrated server clock or the server itself can judge a server-issued expiry. */
export function readSession(): AuthSession | undefined {
    if (activeStorageKind === 'memory') return memorySession;
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

export function writeSession(session: AuthSession, storageKind: AuthSessionStorageKind = configuredStorageKind): void {
    activeStorageKind = storageKind;
    memorySession = storageKind === 'memory' ? session : undefined;
    if (storageKind !== 'memory') readStorage().setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
    memorySession = undefined;
    if (activeStorageKind !== 'memory') readStorage().removeItem(KEY);
}

export function isLoggedIn(): boolean {
    return readSession() !== undefined;
}
