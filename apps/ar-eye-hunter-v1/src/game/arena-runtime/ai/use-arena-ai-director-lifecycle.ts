import { useEffect } from 'react';

import { startArenaAiDirectorSchedule } from './start-arena-ai-director-schedule.ts';
import type { ArenaConnectionLifecycleInput } from '../lifecycle/use-arena-connection-lifecycle.ts';

export function useArenaAiDirectorLifecycle(
    input: ArenaConnectionLifecycleInput,
): void {
    useEffect(() => startArenaAiDirectorSchedule(input), [
        input.connectionState,
        input.directorStatus.isDirector,
        input.directorStatus.isFresh,
        input.isCurrentNetworkGeneration,
        input.roomId,
        input.runBestEffortNetworkTask,
    ]);
}
