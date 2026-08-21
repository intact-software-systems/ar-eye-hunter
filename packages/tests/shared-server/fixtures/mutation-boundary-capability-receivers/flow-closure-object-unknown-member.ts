import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeUnknownLocalMethod(
    repository: ClientStateRepository,
    method: string
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selection: Readonly<Record<string, () => void>> = {
        selectRead(): void {
            invoke = repository.readSnapshot;
        },
        selectWrite(): void {
            invoke = repository.insertPrincipal;
        }
    };
    selection[method]?.();
    void invoke({} as never);
}
