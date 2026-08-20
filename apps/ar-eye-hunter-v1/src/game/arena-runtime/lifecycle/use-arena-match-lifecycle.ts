import type {
    ArenaConnectionLifecycle,
    ArenaConnectionLifecycleInput,
} from './use-arena-connection-lifecycle.ts';
import { useArenaDirectorAppointment } from '../match/use-arena-director-appointment.ts';
import { useArenaMatchRuntime } from '../match/use-arena-match-runtime.ts';

export function useArenaMatchLifecycle(
    input: ArenaConnectionLifecycleInput,
): Pick<ArenaConnectionLifecycle, 'attemptDirectorAppointment'> {
    const appointment = useArenaDirectorAppointment(input);
    useArenaMatchRuntime(input, appointment.attemptDirectorAppointment);
    return appointment;
}
