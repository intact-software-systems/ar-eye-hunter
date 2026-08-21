import type { ClientStateRepository } from '@shared-server/mod.ts';

export type ImportedRepositoryAlias = ClientStateRepository;
export type ImportedRepositoryHolder = Readonly<{
    nested: Readonly<{ repository: ImportedRepositoryAlias; }>;
}>;
