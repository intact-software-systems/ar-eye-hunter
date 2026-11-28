import { describe, expect, it } from 'vitest';

import { computeQueueWriteFacts } from '../../../../scripts/direct-write-check/queue-write-facts.mjs';
import { createDirectWriteFixture } from './direct-write-check-fixture.ts';

const QUEUE_SOURCES = {
    'packages/shared/queuebox/queue-box-types.ts': `
        export interface ResourceEntry { readonly key: string; }
        export interface EnqueueResourceEntryController {
            enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>;
            replaceIfObserved(expected: ResourceEntry, replacement: ResourceEntry): Promise<ResourceEntry | null>;
            findByKey(key: string): Promise<ResourceEntry | undefined>;
        }
        export interface DequeueResourceEntryRepository {
            reserveEntries(limit: number): Promise<readonly ResourceEntry[]>;
            releaseEntries(entries: readonly ResourceEntry[]): Promise<void>;
        }
    `,
    'packages/shared-server/queuebox/postgres/p-sql-queue-box.ts': `
        import type { EnqueueResourceEntryController, ResourceEntry } from '../../../shared/queuebox/queue-box-types.ts';
        export declare class PSqlQueueBox implements EnqueueResourceEntryController {
            enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>;
            replaceIfObserved(expected: ResourceEntry, replacement: ResourceEntry): Promise<ResourceEntry | null>;
            findByKey(key: string): Promise<ResourceEntry | undefined>;
        }
    `
} as const;
const ROUTE_PATH = 'apps/api-v1/src/routes/display/register-display-routes.ts';

describe('queue write facts', () => {
    it('records each owner that writes, claims or releases queue rows through a queue-typed receiver, by method', () => {
        const facts = computeFixtureFacts(`
            import type { DequeueResourceEntryRepository, ResourceEntry } from '../../../../../packages/shared/queuebox/queue-box-types.ts';
            import type { PSqlQueueBox } from '../../../../../packages/shared-server/queuebox/postgres/p-sql-queue-box.ts';
            export class DisplayRoutes {
                constructor(private readonly outbox: PSqlQueueBox, private readonly work: DequeueResourceEntryRepository) {}
                async onPost(entry: ResourceEntry): Promise<void> {
                    await this.outbox.enqueueIfAbsent(entry);
                    await this.outbox.replaceIfObserved(entry, entry);
                    await this.outbox.enqueueIfAbsent(entry);
                }
                async onDrain(): Promise<void> {
                    await this.work.releaseEntries(await this.work.reserveEntries(10));
                }
            }
        `);

        expect(facts).toEqual([
            { id: `${ROUTE_PATH}#DisplayRoutes.onDrain`, count: 2, methods: ['releaseEntries', 'reserveEntries'] },
            { id: `${ROUTE_PATH}#DisplayRoutes.onPost`, count: 3, methods: ['enqueueIfAbsent', 'replaceIfObserved'] }
        ]);
    });

    it('ignores a queue read, a method of that name on another type, and a call through a port declared elsewhere', () => {
        const facts = computeFixtureFacts(`
            import type { ResourceEntry } from '../../../../../packages/shared/queuebox/queue-box-types.ts';
            import type { PSqlQueueBox } from '../../../../../packages/shared-server/queuebox/postgres/p-sql-queue-box.ts';
            interface DisplayWorkPort { enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>; }
            class SendQueue { enqueue(value: string): void { void value; } }
            export async function onDisplay(outbox: PSqlQueueBox, port: DisplayWorkPort, entry: ResourceEntry): Promise<void> {
                await outbox.findByKey(entry.key);
                await port.enqueueIfAbsent(entry);
                new SendQueue().enqueue('frame');
            }
        `);

        expect(facts).toEqual([]);
    });
});

function computeFixtureFacts(routeSource: string) {
    const { project, scope } = createDirectWriteFixture({ ...QUEUE_SOURCES, [ROUTE_PATH]: routeSource });
    return computeQueueWriteFacts(project, scope);
}
