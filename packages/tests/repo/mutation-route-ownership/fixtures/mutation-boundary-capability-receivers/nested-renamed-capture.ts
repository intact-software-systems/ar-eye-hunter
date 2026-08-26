import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

type NestedInput = Readonly<{
    nested: Readonly<{ repository: ClientStateRepository; }>;
}>;

export function mutateNestedCapture(input: NestedInput): void {
    let captured: unknown = undefined;
    captured = input.nested.repository;
    [0].forEach(() => {
        const { insertPrincipal: write } = captured as ClientStateRepository;
        void write({} as never);
    });
}
