import type {
    ArenaConnectionLifecycle,
    ArenaConnectionLifecycleInput,
} from './use-arena-connection-lifecycle.ts';
import {
    useArenaConnectionSessionLifecycle,
} from '../transport/use-arena-connection-session-lifecycle.ts';
import { useArenaRtcLifecycle } from '../transport/use-arena-rtc-lifecycle.ts';

export function useArenaTransportLifecycle(
    input: ArenaConnectionLifecycleInput,
): Pick<ArenaConnectionLifecycle, 'connect'> {
    const connection = useArenaConnectionSessionLifecycle(input);
    useArenaRtcLifecycle(input);
    return connection;
}
