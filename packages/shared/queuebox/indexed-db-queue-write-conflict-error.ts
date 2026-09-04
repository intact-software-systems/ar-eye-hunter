export class IndexedDbQueueWriteConflictError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'IndexedDbQueueWriteConflictError';
    }
}
