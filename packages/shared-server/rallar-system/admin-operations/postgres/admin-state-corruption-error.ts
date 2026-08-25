export class AdminStateCorruptionError extends Error {
    readonly code = 'admin-operations-state-invariant-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'AdminStateCorruptionError';
    }
}
