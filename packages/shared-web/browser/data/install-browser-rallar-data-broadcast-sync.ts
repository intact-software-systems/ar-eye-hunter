import type { RepositoryBackedRallarDataStore } from '@shared-web/browser/data/repository-backed-rallar-data-store.ts';

/** Installs cross-tab synchronization for one managed Rallar Data repository. */
export function installBrowserRallarDataBroadcastSync<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    enabled: boolean
): void {
    if (!enabled || typeof BroadcastChannel === 'undefined') {
        return;
    }

    const channel = new BroadcastChannel(`rallar-data:${managed.id}`);
    channel.onmessage = (event: MessageEvent) => {
        const message = event.data as Partial<RepositoryBackedRallarDataStore.BroadcastMessage<V>>;
        if (
            message.version !== 1 ||
            message.repositoryId !== managed.id ||
            message.instanceId === managed.instanceId
        ) {
            return;
        }

        void applyRemoteChange(managed, message).catch((error) => {
            console.error('Error applying remote Rallar data change', error);
        });
    };
    managed.broadcast = channel;
}

async function applyRemoteChange<V>(
    managed: RepositoryBackedRallarDataStore.Managed<V>,
    message: Partial<RepositoryBackedRallarDataStore.BroadcastMessage<V>>
): Promise<void> {
    if (message.type === 'set') {
        if (message.key === undefined || message.value === undefined) {
            return;
        }
        await Promise.resolve(managed.repository.set(message.key, message.value));
        return;
    }
    if (message.type === 'delete') {
        if (message.key === undefined) {
            return;
        }
        await Promise.resolve(managed.repository.delete(message.key));
        return;
    }
    if (message.type === 'clear') {
        await Promise.resolve(managed.repository.clearAll());
    }
}
