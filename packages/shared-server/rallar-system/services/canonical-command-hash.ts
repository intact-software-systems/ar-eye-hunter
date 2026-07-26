import {
    hashMutationCommand,
    type JsonWireValue,
} from './mutation-command-identity.ts';

/** Hashes any canonical JSON command; the name is intentionally domain-neutral. */
export async function hashCanonicalCommand(command: unknown): Promise<string> {
    return await hashMutationCommand(command as JsonWireValue);
}
