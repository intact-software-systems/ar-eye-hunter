export function distributedRecipeStateTone(state: string): string {
    if (state === 'passed' || state === 'ready') {
        return 'good';
    }
    if (state === 'running' || state === 'waiting-for-ack' || state === 'waiting-for-barrier' || state === 'staging') {
        return 'active';
    }
    if (state === 'failed' || state === 'timed-out') {
        return 'bad';
    }
    if (state === 'cancelled') {
        return 'warn';
    }
    return 'muted';
}
