import { useEffect } from 'react';

import {
    type ArenaAiDirectorScheduleInput,
    startArenaAiDirectorSchedule,
} from './start-arena-ai-director-schedule.ts';

export function useArenaAiDirectorLifecycle(
    input: ArenaAiDirectorScheduleInput,
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
