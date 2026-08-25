import type {
    RallarDataChangeListener,
    RallarDataDurability,
    RallarDataScope,
    RallarDataStorageEstimate,
    RallarDataStore,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-data.ts';
import type { WriteBehindObservableLatestRepository } from '@shared/cache/WriteBehindObservableLatestRepository.ts';
import type { WriteThroughObservableLatestRepository } from '@shared/cache/WriteThroughObservableLatestRepository.ts';
import type { PersistenceProvider } from '@shared/persistence/PersistenceProvider.ts';

export namespace RepositoryBackedRallarDataStore {
    export interface Lifecycle {
        readonly id: string;
        readonly scopeKey: string;
        readonly durability: RallarDataDurability;
        readonly persistence: Pick<PersistenceProvider<string, object>, 'getAllKeys' | 'removeItem'>;
        readonly repository: Readonly<{
            clearAll(): void | Promise<void>;
            whenIdle(): Promise<void>;
        }>;
        readonly instanceId: string;
        broadcast?: BroadcastChannel;
    }

    export interface Managed<V> extends Lifecycle {
        readonly name: string;
        readonly optionsKey: string;
        readonly scope: RallarDataScope;
        readonly persistence: PersistenceProvider<string, V>;
        readonly repository:
            | WriteThroughObservableLatestRepository<string, V>
            | WriteBehindObservableLatestRepository<string, V>;
        readonly instanceId: string;
        broadcast?: BroadcastChannel;
        dispose(): Promise<void>;
    }

    export type BroadcastMessage<V> = Readonly<{
        version: 1;
        repositoryId: string;
        instanceId: string;
        type: 'set' | 'delete' | 'clear';
        key?: string;
        value?: V;
    }>;
}

export class RepositoryBackedRallarDataStore<V> implements RallarDataStore<V> {
    public readonly repositoryId: string;

    public readonly name: string;
    private readonly managed: RepositoryBackedRallarDataStore.Managed<V>;
    private readonly closeRepository: () => Promise<boolean>;

    public constructor(
        name: string,
        managed: RepositoryBackedRallarDataStore.Managed<V>,
        closeRepository: () => Promise<boolean>
    ) {
        this.name = name;
        this.managed = managed;
        this.closeRepository = closeRepository;
        this.repositoryId = managed.id;
    }

    public async hydrate(): Promise<void> {
        await this.managed.repository.hydrate();
    }

    public whenHydrated(): Promise<void> {
        return this.managed.repository.whenHydrated();
    }

    public isHydrated(): boolean {
        return this.managed.repository.isHydrated();
    }

    public whenIdle(): Promise<void> {
        return this.managed.repository.whenIdle();
    }

    public flush(): Promise<void> {
        return this.managed.repository.flush();
    }

    public read(key: string): V | undefined {
        return this.managed.repository.read(key);
    }

    public async get(key: string): Promise<V | undefined> {
        if (this.managed.durability === 'write-through') {
            return await this.managed.repository.get(key);
        }

        await this.hydrate();
        return this.managed.repository.read(key);
    }

    public readEntries(): Array<readonly [string, V]> {
        const entries: Array<readonly [string, V]> = [];

        for (const [key, latestValue] of this.managed.repository.entriesView()) {
            const value = latestValue.read();
            if (value !== undefined) {
                entries.push([key, value]);
            }
        }

        return entries;
    }

    public readAllValues(): V[] {
        return this.managed.repository.readAllValues();
    }

    public async getEntries(): Promise<Array<readonly [string, V]>> {
        if (this.managed.durability === 'write-behind') {
            await this.hydrate();
        }

        const entries = new Map<string, V>();

        for (const [key, value] of this.readEntries()) {
            entries.set(key, value);
        }

        for (const key of await this.managed.persistence.getAllKeys()) {
            const value = await this.get(key);
            if (value !== undefined) {
                entries.set(key, value);
            }
        }

        return Array.from(entries.entries());
    }

    public async getAll(): Promise<V[]> {
        return (await this.getEntries()).map(([, value]) => value);
    }

    public async listKeys(): Promise<string[]> {
        return [
            ...new Set([
                ...this.keys(),
                ...(await this.managed.persistence.getAllKeys())
            ])
        ].sort();
    }

    public keys(): string[] {
        return Array.from(this.managed.repository.keys());
    }

    public async exportData(): Promise<Record<string, V>> {
        return Object.fromEntries(await this.getEntries()) as Record<string, V>;
    }

    public async set(key: string, value: V): Promise<void> {
        await this.setLocal(key, value);
        this.broadcast({
            type: 'set',
            key,
            value
        });
    }

    public async update(
        key: string,
        updater: (current: V) => V
    ): Promise<V | undefined> {
        const current = await this.get(key);
        if (current === undefined) {
            return undefined;
        }

        const next = updater(current);
        await this.set(key, next);
        return next;
    }

    public async updateOrCreate(
        key: string,
        updater: (current: V | undefined) => V
    ): Promise<V> {
        const next = updater(await this.get(key));
        await this.set(key, next);
        return next;
    }

    public async setIfAbsent(key: string, creator: () => V): Promise<V> {
        const current = await this.get(key);
        if (current !== undefined) {
            return current;
        }

        const next = creator();
        await this.set(key, next);
        return next;
    }

    public async compareAndSet(
        key: string,
        expect: V | undefined,
        update: V
    ): Promise<boolean> {
        const current = await this.get(key);
        if (!Object.is(current, expect)) {
            return false;
        }

        await this.set(key, update);
        return true;
    }

    public async getAndSet(key: string, update: V): Promise<V | undefined> {
        const current = await this.get(key);
        await this.set(key, update);
        return current;
    }

    public async delete(key: string): Promise<boolean> {
        const deleted = await this.deleteLocal(key);
        this.broadcast({
            type: 'delete',
            key
        });
        return deleted;
    }

    public async deleteExpired(): Promise<number> {
        const memoryExpiredKeys = this.keys().filter((key) => this.managed.repository.expired(key));
        const deletedFromPersistence = await this.managed.persistence.deleteExpired();

        for (const key of memoryExpiredKeys) {
            await Promise.resolve(this.managed.repository.delete(key));
            this.broadcast({
                type: 'delete',
                key
            });
        }

        return deletedFromPersistence;
    }

    public async clear(): Promise<void> {
        await this.clearAll();
    }

    public async clearAll(): Promise<void> {
        await clearManagedRallarDataRepository(this.managed);
        this.broadcast({
            type: 'clear'
        });
    }

    public async close(): Promise<boolean> {
        await this.flush();
        return await this.closeRepository();
    }

    public async destroy(): Promise<void> {
        await this.clearAll();
        await this.closeRepository();
    }

    public estimateUsage(): Promise<RallarDataStorageEstimate> {
        return estimateBrowserStorage();
    }

    public onChange(listener: RallarDataChangeListener<V>): RallarUnsubscribe {
        const unsubscribe = this.managed.repository.onChangeDo(listener);
        return () => {
            unsubscribe.unsubscribe();
        };
    }

    private async setLocal(key: string, value: V): Promise<void> {
        await Promise.resolve(this.managed.repository.set(key, value));
    }

    private async deleteLocal(key: string): Promise<boolean> {
        if (this.managed.durability === 'write-behind') {
            const existed = this.managed.repository.has(key) ||
                (await this.managed.persistence.getItem(key)) !== undefined;
            await this.managed.persistence.removeItem(key);
            const memoryDeleted = this.managed.repository.delete(key);
            return existed || memoryDeleted;
        }

        return await Promise.resolve(this.managed.repository.delete(key));
    }

    private broadcast(
        message: Omit<RepositoryBackedRallarDataStore.BroadcastMessage<V>, 'version' | 'repositoryId' | 'instanceId'>
    ): void {
        this.managed.broadcast?.postMessage(
            {
                version: 1,
                repositoryId: this.managed.id,
                instanceId: this.managed.instanceId,
                ...message
            } satisfies RepositoryBackedRallarDataStore.BroadcastMessage<V>
        );
    }
}

export async function clearManagedRallarDataRepository(
    managed: RepositoryBackedRallarDataStore.Lifecycle
): Promise<void> {
    if (managed.durability === 'write-behind') {
        const keys = await managed.persistence.getAllKeys();
        await Promise.all(keys.map((key) => managed.persistence.removeItem(key)));
        managed.repository.clearAll();
        await managed.repository.whenIdle();
        return;
    }

    await Promise.resolve(managed.repository.clearAll());
}

export function broadcastRallarDataClear(
    managed: RepositoryBackedRallarDataStore.Lifecycle
): void {
    managed.broadcast?.postMessage(
        {
            version: 1,
            repositoryId: managed.id,
            instanceId: managed.instanceId,
            type: 'clear'
        } satisfies RepositoryBackedRallarDataStore.BroadcastMessage<object>
    );
}

export async function estimateBrowserStorage(): Promise<RallarDataStorageEstimate> {
    return (await navigator.storage?.estimate?.()) ?? {};
}
