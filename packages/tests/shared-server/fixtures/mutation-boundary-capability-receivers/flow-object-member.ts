import type { ClientStateRepository } from '@shared-server/mod.ts';

export function callObjectMemberBeforeReadOverwrite(
    repository: ClientStateRepository
): void {
    const holder: {
        invoke:
            | ClientStateRepository['insertPrincipal']
            | ClientStateRepository['readSnapshot'];
    } = { invoke: repository.insertPrincipal };
    void holder.invoke({} as never);
    holder.invoke = repository.readSnapshot;
}
