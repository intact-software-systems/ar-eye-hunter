import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';

export async function deriveAuthMutationId(
  kind: 'user' | 'session' | 'agent-session',
  identity: readonly string[],
): Promise<string> {
  const digest = await hashAuthSecret(JSON.stringify([kind, ...identity]));
  return `${kind}-${digest.slice(0, 24)}`;
}
