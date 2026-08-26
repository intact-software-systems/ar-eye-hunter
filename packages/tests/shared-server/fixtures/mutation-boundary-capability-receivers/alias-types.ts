import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export type ImportedRepositoryAlias = ClientStateRepository;
export type ImportedRepositoryHolder = Readonly<{
    nested: Readonly<{ repository: ImportedRepositoryAlias; }>;
}>;
