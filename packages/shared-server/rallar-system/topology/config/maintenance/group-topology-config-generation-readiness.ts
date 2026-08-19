import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { GroupTopologyConfigRepository } from '../persistence/group-topology-config-repository.ts';
import { backfillGroupTopologyConfigGenerationsForRef } from './backfill-group-topology-config-generations.ts';

export class GroupTopologyConfigGenerationReadiness {
  private readonly readinessByGroupKey = new Map<string, Promise<void>>();
  private readonly repository: GroupTopologyConfigRepository | undefined;
  private readonly sleep: ((delayMs: number) => Promise<void>) | undefined;

  constructor(
    repository: GroupTopologyConfigRepository | undefined,
    sleep?: (delayMs: number) => Promise<void>,
  ) {
    this.repository = repository;
    this.sleep = sleep;
  }

  async ensure(groupRef: GroupRef): Promise<void> {
    if (!this.repository) {
      return;
    }

    const groupKey = toScopedOverlayId(groupRef);
    let readiness = this.readinessByGroupKey.get(groupKey);
    if (!readiness) {
      readiness = backfillGroupTopologyConfigGenerationsForRef(this.repository, groupRef, {
        sleep: this.sleep,
      }).then(() => undefined);
      this.readinessByGroupKey.set(groupKey, readiness);
    }

    try {
      await readiness;
    } catch (error) {
      if (this.readinessByGroupKey.get(groupKey) === readiness) {
        this.readinessByGroupKey.delete(groupKey);
      }
      throw error;
    }
  }
}
