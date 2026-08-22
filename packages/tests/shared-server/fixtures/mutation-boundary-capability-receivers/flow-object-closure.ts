import type { ClientStateRepository } from '@shared-server/mod.ts';

export function captureObjectMemberReassignment(repository: ClientStateRepository): void {
    const holder: {
        invoke:
            | ClientStateRepository['insertPrincipal']
            | ClientStateRepository['readSnapshot'];
    } = { invoke: repository.insertPrincipal };
    const selectRead = () => {
        holder.invoke = repository.readSnapshot;
    };
    void selectRead;
    void holder.invoke({} as never);
}
