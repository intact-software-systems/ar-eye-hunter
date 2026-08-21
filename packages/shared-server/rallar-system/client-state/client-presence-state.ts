import type { ClientPresenceState, ClientSession } from '@shared/api/client-types.ts';

function toClientPresenceState(sessions: readonly ClientSession[]): ClientPresenceState {
    if (sessions.some((session) => session.presenceState === 'busy')) {
        return 'busy';
    }
    if (sessions.some((session) => session.presenceState === 'away')) {
        return 'away';
    }
    if (sessions.some((session) => session.presenceState === 'online')) {
        return 'online';
    }
    return 'offline';
}

export { toClientPresenceState };
