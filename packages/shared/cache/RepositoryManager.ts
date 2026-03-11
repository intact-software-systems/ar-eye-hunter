import { DisposableRepository, RepositoryToken } from './RepositoryToken.ts';

type ManagedRepository = unknown;

export class RepositoryManager {
    private readonly repositories = new Map<string, ManagedRepository>();

    public has(token: RepositoryToken<unknown>): boolean;
    public has(id: string): boolean;
    public has(tokenOrId: RepositoryToken<unknown> | string): boolean {
        return this.repositories.has(this.toId(tokenOrId));
    }

    public size(): number {
        return this.repositories.size;
    }

    public ids(): readonly string[] {
        return Array.from(this.repositories.keys());
    }

    public get<R>(token: RepositoryToken<R>): R | undefined {
        return this.repositories.get(token.id) as R | undefined;
    }

    public require<R>(token: RepositoryToken<R>): R {
        const repository = this.get(token);
        if (repository === undefined) {
            throw new Error(`Repository not found: ${token.id}`);
        }
        return repository;
    }

    /**
     * Registers only if absent. Throws if already present.
     */
    public register<R>(token: RepositoryToken<R>, repository: R): R {
        if (this.repositories.has(token.id)) {
            throw new Error(`Repository already registered: ${token.id}`);
        }

        this.repositories.set(token.id, repository);
        return repository;
    }

    /**
     * Overwrites without disposing any existing instance.
     */
    public set<R>(token: RepositoryToken<R>, repository: R): R {
        this.repositories.set(token.id, repository);
        return repository;
    }

    /**
     * Returns existing instance or creates one from the token factory.
     */
    public resolve<R>(token: RepositoryToken<R>): R {
        const existing = this.get(token);
        if (existing !== undefined) {
            return existing;
        }

        const created = token.create();
        this.repositories.set(token.id, created);
        return created;
    }

    /**
     * Replaces existing instance and disposes the old one if supported.
     */
    public async replace<R>(token: RepositoryToken<R>, repository: R): Promise<R> {
        const existing = this.repositories.get(token.id) as DisposableRepository | undefined;

        if (existing) {
            await existing.dispose?.();
        }

        this.repositories.set(token.id, repository);
        return repository;
    }

    public async delete(token: RepositoryToken<unknown>): Promise<boolean>;
    public async delete(id: string): Promise<boolean>;
    public async delete(tokenOrId: RepositoryToken<unknown> | string): Promise<boolean> {
        const id = this.toId(tokenOrId);
        const repository = this.repositories.get(id) as DisposableRepository | undefined;

        if (repository === undefined) {
            return false;
        }

        await repository.dispose?.();
        return this.repositories.delete(id);
    }

    public async clear(): Promise<void> {
        const repositories = Array.from(this.repositories.values()) as DisposableRepository[];

        this.repositories.clear();

        for (const repository of repositories) {
            await repository.dispose?.();
        }
    }

    private toId(tokenOrId: RepositoryToken<unknown> | string): string {
        return typeof tokenOrId === 'string' ? tokenOrId : tokenOrId.id;
    }
}