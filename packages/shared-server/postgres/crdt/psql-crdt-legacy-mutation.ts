export function assertLegacyCrdtMutationAllowed(allowed: boolean): void {
    if (!allowed) {
        throw new Error(
            'Direct PostgreSQL CRDT mutation is disabled; use transaction-bound AppInbox orchestration.',
        );
    }
}
