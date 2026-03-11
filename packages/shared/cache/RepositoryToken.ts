export interface DisposableRepository {
    dispose?(): void | Promise<void>;
}

export class RepositoryToken<R> {
    public constructor(
        public readonly id: string,
        public readonly create: () => R,
    ) {
        if (!id) {
            throw new Error('RepositoryToken id is required');
        }

        if (!create) {
            throw new Error('RepositoryToken create factory is required');
        }
    }
}