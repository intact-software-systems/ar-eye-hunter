import type { ImportedRepositoryHolder } from './alias-types.ts';

export function mutateImportedObjectAlias(input: ImportedRepositoryHolder): void {
  void input.nested.repository.insertPrincipal({} as never);
}
