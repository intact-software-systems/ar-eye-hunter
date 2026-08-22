import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';

export async function toExactPersistedEvidenceMatches(match: string): Promise<
    Readonly<{
        raw: string;
        digest: string;
    }>
> {
    return { raw: match, digest: await hashAuthSecret(match) };
}
