import { describe, expect, it } from 'vitest';

import { computeRepositoryWriteFacts } from '../../../../scripts/direct-write-check/repository-write-facts.mjs';
import { createDirectWriteFixture } from './direct-write-check-fixture.ts';

const STORE_PATH = 'packages/shared-server/runtime-state/runtime-state-json-store.ts';
const CLIENT_PATH = 'packages/shared-server/rallar-system/client-state/client-state-repository.ts';
const ROUTE_PATH = 'apps/api-v1/src/routes/client-state-routes.ts';

interface RepositoryWriteFact {
    readonly id: string;
}

const REPOSITORY_SOURCES = {
    'packages/shared-server/runtime-state/runtime-state-repository.ts': `
        export interface RuntimeStateRepositoryLike {
            findEntry(key: string): Promise<string | undefined>;
            upsert(key: string): Promise<void>;
            begin<T>(write: (repository: RuntimeStateRepositoryLike) => Promise<T>): Promise<T>;
        }
    `,
    [STORE_PATH]: `
        import type { RuntimeStateRepositoryLike } from './runtime-state-repository.ts';
        export class RuntimeStateJsonStore {
            constructor(protected readonly repository: RuntimeStateRepositoryLike) {}
            protected async putValue(key: string): Promise<void> { await this.repository.upsert(key); }
            protected async getValue(key: string): Promise<string | undefined> { return this.repository.findEntry(key); }
        }
    `,
    [CLIENT_PATH]: `
        import { RuntimeStateJsonStore } from '../../runtime-state/runtime-state-json-store.ts';
        export class ClientStateRepository extends RuntimeStateJsonStore {
            async writeClient(key: string): Promise<void> { await this.putValue(key); }
            async readClient(key: string): Promise<string | undefined> { return this.getValue(key); }
        }
    `
} as const;

describe('repository write facts', () => {
    it('records, per class, how many methods call a write primitive on a root repository or reach one', () => {
        expect(computeFixtureFacts({})).toEqual([
            { id: `${CLIENT_PATH}#ClientStateRepository`, count: 1 },
            { id: `${STORE_PATH}#RuntimeStateJsonStore`, count: 1 }
        ]);
    });

    it('counts a second writing method of a class that is already recorded', () => {
        const facts = computeFixtureFacts({
            [CLIENT_PATH]: REPOSITORY_SOURCES[CLIENT_PATH].replace(
                'async readClient(',
                'async renameClient(key: string): Promise<void> { await this.writeClient(key); }\n            async readClient('
            )
        });

        expect(facts).toContainEqual({ id: `${CLIENT_PATH}#ClientStateRepository`, count: 2 });
    });

    it('records a handler writing a root repository directly, and callers of a domain write to a fixed point', () => {
        const facts = computeFixtureFacts({
            [ROUTE_PATH]: `
                import type { RuntimeStateRepositoryLike } from '../../../../packages/shared-server/runtime-state/runtime-state-repository.ts';
                import { ClientStateRepository } from '../../../../packages/shared-server/rallar-system/client-state/client-state-repository.ts';
                export async function onClientFrame(repository: RuntimeStateRepositoryLike): Promise<void> {
                    await repository.upsert('frame');
                }
                export class ClientConnectService {
                    constructor(private readonly clients: ClientStateRepository) {}
                    async connect(key: string): Promise<void> { await this.clients.writeClient(key); }
                }
                export class ClientConnectRoute {
                    constructor(private readonly service: ClientConnectService) {}
                    async post(key: string): Promise<void> { await this.service.connect(key); }
                }
            `
        });

        expect(facts.map((fact: { readonly id: string; }) => fact.id)).toEqual([
            `${ROUTE_PATH}#ClientConnectRoute`,
            `${ROUTE_PATH}#ClientConnectService`,
            `${ROUTE_PATH}#onClientFrame`,
            `${CLIENT_PATH}#ClientStateRepository`,
            `${STORE_PATH}#RuntimeStateJsonStore`
        ]);
    });

    it('ignores a primitive on a transaction, a read caller, and a write through a provider interface', () => {
        const facts = computeFixtureFacts({
            [ROUTE_PATH]: `
                import type { RuntimeStateRepositoryLike } from '../../../../packages/shared-server/runtime-state/runtime-state-repository.ts';
                import { ClientStateRepository } from '../../../../packages/shared-server/rallar-system/client-state/client-state-repository.ts';
                interface PersistenceProvider { upsert(key: string): Promise<void>; }
                export async function writeInTransaction(transaction: RuntimeStateRepositoryLike): Promise<void> {
                    await transaction.upsert('inside');
                }
                export async function writeInOpenedTransaction(repository: RuntimeStateRepositoryLike): Promise<void> {
                    await repository.begin(async (opened) => opened.upsert('opened'));
                }
                export async function readClient(clients: ClientStateRepository): Promise<void> {
                    await clients.readClient('read');
                }
                export async function writeProvider(provider: PersistenceProvider): Promise<void> {
                    await provider.upsert('provider');
                }
            `
        });

        expect(facts).toEqual(computeFixtureFacts({}));
    });
});

function computeFixtureFacts(sources: Readonly<Record<string, string>>) {
    const { project, scope } = createDirectWriteFixture({ ...REPOSITORY_SOURCES, ...sources });
    return computeRepositoryWriteFacts(project, scope);
}
