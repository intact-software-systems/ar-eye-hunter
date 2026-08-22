import type { PersistedAuthSession } from '../../auth/persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import { authSessionProofSecret } from '../../auth/sessions/auth-session-proof-secret.ts';

export type TopologyMutationAuthorityProof = Readonly<{
    version: 1;
    principalId: string;
    sessionId: string;
    sessionIssuedAtEpochMs: number;
    sessionExpiresAtEpochMs: number;
    commandHash: string;
    commandMac: string;
}>;

export async function createTopologyMutationAuthorityProof(
    session: IssuedAuthSession | PersistedAuthSession,
    commandHash: string
): Promise<TopologyMutationAuthorityProof> {
    const proof = {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandHash
    } as const;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(await authSessionProofSecret(session)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const bytes = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(
            JSON.stringify({
                purpose: 'rallar-topology-mutation-authority',
                ...proof
            })
        )
    );
    return {
        ...proof,
        commandMac: [...new Uint8Array(bytes)]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
    };
}
