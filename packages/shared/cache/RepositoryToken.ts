export interface DisposableRepository {
    dispose?(): void | Promise<void>;
}

export class RepositoryToken<R> {
    public readonly id: string;
    public readonly create: () => R;

    public constructor(
        id: string,
        create: () => R
    ) {
        this.id = id;
        this.create = create;
        if (!id) {
            throw new Error('RepositoryToken id is required');
        }

        if (!create) {
            throw new Error('RepositoryToken create factory is required');
        }
    }
}
