import { hashAuthSecret } from '@shared-server/rallar-system/repositories/auth-secret-digest.ts';

export async function toExactPersistedEvidenceMatches(match: string): Promise<
  Readonly<{
    raw: string;
    digest: string;
  }>
> {
  return { raw: match, digest: await hashAuthSecret(match) };
}
