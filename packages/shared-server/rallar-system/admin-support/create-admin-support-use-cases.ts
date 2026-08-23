import type { AdminSupportUseCaseDependencies, AdminSupportUseCases } from './admin-support-contracts.ts';
import { ClientAdminSupport } from './client-admin-support.ts';
import { CrdtAdminSupport } from './crdt-admin-support.ts';
import { GroupAdminSupport } from './group-admin-support.ts';
import { QueueAdminSupport } from './queue-admin-support.ts';

export function createAdminSupportUseCases(
    dependencies: AdminSupportUseCaseDependencies
): AdminSupportUseCases {
    const client = new ClientAdminSupport(dependencies);
    const group = new GroupAdminSupport(dependencies);
    const crdt = new CrdtAdminSupport(dependencies);
    const queue = new QueueAdminSupport(dependencies);
    return {
        explainClient: (input) => client.explainClient(input),
        explainGroup: (input) => group.explainGroup(input),
        explainRequest: (input) => queue.explainRequest(input),
        explainCrdtDocument: (input) => crdt.explainCrdtDocument(input),
        explainQueueItem: (input) => queue.explainQueueItem(input)
    };
}
