import { hashMutationCommand, type JsonWireValue } from '../protocol/json-wire-identity.ts';

/** Hashes any canonical JSON command; the name is intentionally domain-neutral. */
export async function hashCanonicalCommand(command: JsonWireValue): Promise<string> {
    return await hashMutationCommand(command);
}
