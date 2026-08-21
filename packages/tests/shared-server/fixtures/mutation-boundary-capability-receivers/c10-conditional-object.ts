import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeConditionalObject(
    repository: ClientStateRepository,
    enabled: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const writeSelector = {
        select(): void {
            invoke = repository.insertPrincipal;
        }
    };
    const readSelector = {
        select(): void {
            invoke = repository.readSnapshot;
        }
    };
    const selector = enabled ? writeSelector : readSelector;
    selector.select();
    void invoke({} as never);
}
