import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';

/** Hashes any canonical JSON command; the name is intentionally domain-neutral. */
export async function hashCanonicalCommand(command: unknown): Promise<string> {
    return await hashStateMutationCommand(command);
}
