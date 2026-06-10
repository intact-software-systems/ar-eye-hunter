import type { ClientPrincipalRef, ClientSnapshot, } from '@shared/api/client-types.ts';
import { readClientVersion } from '@shared/api/group-client-views.ts';
import {
    findClientStateSnapshotByPrincipalId,
    setClientStateSnapshotByPrincipalId,
} from '@shared/repository/client-state-snapshots-repository.ts';
import { ObservableLoanedRepository } from '@shared/cache/ObservableLoanedRepository.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import type { ClientStateRepository } from '../repositories/ClientStateRepository.ts';
import { isClientSnapshotPresenceFresh, type RallarSnapshotPresenceClock, } from '../snapshot-presence.ts';

const DEFAULT_TTL_MS = 60_000;

export type ClientStateSnapshotReadThroughCacheOptions = Readonly<{
    clientsRepository: Pick<ClientStateRepository, 'readSnapshot'>;
    manager?: RepositoryManager;
    ttlMs?: number;
    now?: RallarSnapshotPresenceClock;
}>;

export type FindOrLoadClientStateSnapshotOptions = Readonly<{
    minSnapshotVersion?: number;
}>;

export class ClientStateSnapshotNotFoundError extends Error {
    constructor(readonly ref: ClientPrincipalRef) {
        super(
            `Client snapshot not found for ${ref.applicationId}/${ref.workspaceId ?? ''}/${ref.principalId}`,
        );
        this.name = 'ClientStateSnapshotNotFoundError';
    }
}

export class ClientStateSnapshotReadThroughCache {
    private readonly snapshots: ObservableLoanedRepository<string, ClientSnapshot>;

    constructor(
        private readonly options: ClientStateSnapshotReadThroughCacheOptions,
    ) {
        this.snapshots = new ObservableLoanedRepository<string, ClientSnapshot>(
            async (key) => {
                const ref = fromClientStateSnapshotRepositoryKey(key);
                const snapshot = await options.clientsRepository.readSnapshot(ref);
                if (!snapshot) {
                    throw new ClientStateSnapshotNotFoundError(ref);
                }

                return snapshot;
            },
            {
                ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
                equals: (left, right) => readClientVersion(left) === readClientVersion(right),
            },
        );
        this.snapshots.onChangeDo((event) => {
            if (event.value) {
                setClientStateSnapshotByPrincipalId(
                    event.value.principal.principalId,
                    event.value,
                    this.options.manager,
                );
            }
        });
    }

    public findByRef(ref: ClientPrincipalRef): ClientSnapshot | undefined {
        const latest = findClientStateSnapshotByPrincipalId(
            ref.principalId,
            this.options.manager,
        );
        if (
            latest &&
            isSameClientPrincipalRef(latest.principal, ref) &&
            this.isPresenceFresh(latest)
        ) {
            return latest;
        }

        const loaned = this.snapshots.read(toClientStateSnapshotRepositoryKey(ref));
        return this.isPresenceFresh(loaned) ? loaned : undefined;
    }

    public readLoadedSnapshots(): ClientSnapshot[] {
        return this.snapshots.readAllValues();
    }

    public async findOrLoadByRef(
        ref: ClientPrincipalRef,
        options: FindOrLoadClientStateSnapshotOptions = {},
    ): Promise<ClientSnapshot | undefined> {
        const key = toClientStateSnapshotRepositoryKey(ref);
        const latest = findClientStateSnapshotByPrincipalId(
            ref.principalId,
            this.options.manager,
        );
        if (
            latest &&
            isSameClientPrincipalRef(latest.principal, ref) &&
            this.isUsable(latest, options.minSnapshotVersion)
        ) {
            return latest;
        }

        const loaned = this.snapshots.read(key);
        if (this.isUsable(loaned, options.minSnapshotVersion)) {
            setClientStateSnapshotByPrincipalId(
                loaned.principal.principalId,
                loaned,
                this.options.manager,
            );
            return loaned;
        }

        return await this.loadByRef(
            ref,
            (latest !== undefined && isSameClientPrincipalRef(latest.principal, ref)) ||
            loaned !== undefined,
        );
    }

    public async refreshByRef(
        ref: ClientPrincipalRef,
    ): Promise<ClientSnapshot | undefined> {
        return await this.loadByRef(ref, true);
    }

    public async whenIdle(): Promise<void> {
        await this.snapshots.whenIdle();
    }

    private async loadByRef(
        ref: ClientPrincipalRef,
        forceRefresh = false,
    ): Promise<ClientSnapshot | undefined> {
        try {
            const key = toClientStateSnapshotRepositoryKey(ref);
            const snapshot = forceRefresh
                ? await this.snapshots.refresh(key)
                : await this.snapshots.get(key);
            await this.snapshots.whenIdle();
            return snapshot;
        } catch (error) {
            if (error instanceof ClientStateSnapshotNotFoundError) {
                return undefined;
            }

            throw error;
        }
    }

    private isUsable(
        snapshot: ClientSnapshot | undefined,
        minSnapshotVersion: number | undefined,
    ): snapshot is ClientSnapshot {
        return snapshot !== undefined &&
            this.isPresenceFresh(snapshot) &&
            (
                minSnapshotVersion === undefined ||
                readClientVersion(snapshot) >= minSnapshotVersion
            );
    }

    private isPresenceFresh(
        snapshot: ClientSnapshot | undefined,
    ): snapshot is ClientSnapshot {
        return snapshot !== undefined &&
            isClientSnapshotPresenceFresh(snapshot, this.now());
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}

export function createClientStateSnapshotReadThroughCache(
    options: ClientStateSnapshotReadThroughCacheOptions,
): ClientStateSnapshotReadThroughCache {
    return new ClientStateSnapshotReadThroughCache(options);
}

export function toClientStateSnapshotRepositoryKey(
    ref: ClientPrincipalRef,
): string {
    return JSON.stringify([
        ref.applicationId,
        ref.workspaceId ?? '',
        ref.principalId,
    ]);
}

function fromClientStateSnapshotRepositoryKey(key: string): ClientPrincipalRef {
    const [applicationId, workspaceId, principalId] = JSON.parse(key) as [
        string,
        string,
        string,
    ];

    return {
        applicationId,
        workspaceId: workspaceId === '' ? undefined : workspaceId,
        principalId,
    };
}

function isSameClientPrincipalRef(
    left: ClientPrincipalRef,
    right: ClientPrincipalRef,
): boolean {
    return left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '') &&
        left.principalId === right.principalId;
}
