import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';

import type { AdminPruneExpiredOptions } from './admin-prune-options.ts';

export interface AdminExpiredDataPruner {
    countExpired(
        category: AdminPruneExpiredCategory,
        options: AdminPruneExpiredOptions
    ): Promise<number>;
}
