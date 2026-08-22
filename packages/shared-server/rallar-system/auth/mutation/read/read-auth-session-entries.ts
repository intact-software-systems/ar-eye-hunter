import type { AuthSessionRepository } from '../../persistence/auth-session-repository.ts';
import type { AuthSessionEntries } from '../auth-mutation-contracts.ts';

export async function readAuthSessionEntries(
    sessions: AuthSessionRepository,
    expected: Readonly<{ sessionId: string; accessTokenDigest: string; }>
): Promise<AuthSessionEntries> {
    const bySession = await sessions.readSessionBySessionIdEntry(expected.sessionId);
    let byToken = await sessions.readSessionByAccessTokenDigestEntry(expected.accessTokenDigest);
    if (!byToken.value && !byToken.expiredEntry) {
        const legacy = await sessions.findLegacySessionByAccessTokenDigestEntry(
            expected.accessTokenDigest
        );
        byToken = { value: legacy, expiredEntry: undefined };
    }
    return {
        byToken: byToken.value ?? null,
        bySession: bySession.value ?? null,
        expiredByTokenEntry: byToken.expiredEntry ?? null,
        expiredBySessionEntry: bySession.expiredEntry ?? null
    };
}
