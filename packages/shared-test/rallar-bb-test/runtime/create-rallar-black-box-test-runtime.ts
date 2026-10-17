import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestCommandExecutor,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestRuntimeCleanup
} from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxEventHistoryPolicy } from './event-history.ts';
import { InMemoryRallarBlackBoxTestRuntime } from './in-memory-rallar-black-box-test-runtime.ts';
import { sleepWithAbort } from './sleep-with-abort.ts';

export interface CreateRallarBlackBoxTestRuntimeInput {
    readonly eventHistory: RallarBlackBoxEventHistoryPolicy;
    readonly now: () => number;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly idFactory: (prefix: string) => string;
    readonly commandExecutor?: RallarBlackBoxTestCommandExecutor;
    readonly cleanup?: RallarBlackBoxTestRuntimeCleanup;
    /** Reads the page's session ledger and ordering snapshots for `stats`; absent on a runtime that drives no Rallar page. */
    readonly readAlmUsage?: () => Promise<RallarBlackBoxTestAlmUsage | undefined>;
    /** Reads the page's congestion counters for `stats`; absent on a runtime that drives no Rallar page. */
    readonly readCongestionCounters?: () => Promise<ALCongestionCounters | undefined>;
}

export type CreateRallarBlackBoxTestRuntimeOptions = Partial<CreateRallarBlackBoxTestRuntimeInput>;

export function createRallarBlackBoxTestRuntime(
    input: CreateRallarBlackBoxTestRuntimeInput
): RallarBlackBoxTestRuntime {
    return new InMemoryRallarBlackBoxTestRuntime({
        eventHistory: input.eventHistory,
        now: input.now,
        sleep: input.sleep,
        idFactory: input.idFactory,
        commandExecutor: input.commandExecutor,
        cleanup: input.cleanup,
        readAlmUsage: input.readAlmUsage,
        readCongestionCounters: input.readCongestionCounters
    });
}

export function createDefaultRallarBlackBoxTestRuntime(
    options: CreateRallarBlackBoxTestRuntimeOptions = {}
): RallarBlackBoxTestRuntime {
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        eventHistory: options.eventHistory ?? { mode: 'full' },
        now: options.now ?? (() => Date.now()),
        sleep: options.sleep ?? sleepWithAbort,
        idFactory: options.idFactory ??
            ((prefix) => prefix === 'runtime-instance' ? crypto.randomUUID() : `${prefix}-${sequence++}`),
        commandExecutor: options.commandExecutor,
        cleanup: options.cleanup,
        readAlmUsage: options.readAlmUsage,
        readCongestionCounters: options.readCongestionCounters
    });
}
