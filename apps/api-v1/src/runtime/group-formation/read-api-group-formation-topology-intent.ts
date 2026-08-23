import type {
    GroupPresenceSummaryTopologyIntent
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import {
    DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS
} from '@shared-server/rallar-system/topology/replay/rtc-topology-coalesced-group-revision-work.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { EnvReader } from '../../db/database-config.ts';
import { readApiTopologyRecomputeDebounceMs } from '../../services/rtc-topology-config.ts';

export function readApiGroupFormationTopologyIntent(
    outboxQueueReader: OutboxQueueReader,
    env: EnvReader = Deno.env
): GroupPresenceSummaryTopologyIntent {
    return {
        outboxQueueReader,
        recomputeDebounceMs: readApiTopologyRecomputeDebounceMs(env) ??
            DEFAULT_TOPOLOGY_RECOMPUTE_DEBOUNCE_MS
    };
}
