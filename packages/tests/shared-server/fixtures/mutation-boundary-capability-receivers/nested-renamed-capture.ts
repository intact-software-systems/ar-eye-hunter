import type { ClientStateRepository } from '@shared-server/mod.ts';

type NestedInput = Readonly<{
  nested: Readonly<{ repository: ClientStateRepository }>;
}>;

export function mutateNestedCapture(input: NestedInput): void {
  let captured: unknown = undefined;
  captured = input.nested.repository;
  [0].forEach(() => {
    const { insertPrincipal: write } = captured as ClientStateRepository;
    void write({} as never);
  });
}
