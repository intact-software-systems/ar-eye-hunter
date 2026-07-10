import type { DistributedRunProgressStatus } from '../../../distributed-recipes.ts';

export function distributedProgressTone(status: DistributedRunProgressStatus): string {
    if (status === 'ready' || status === 'passed') {
        return 'good';
    }
    if (status === 'failed') {
        return 'bad';
    }
    if (status === 'running' || status === 'queued') {
        return 'active';
    }
    if (status === 'cancelled' || status === 'missing') {
        return 'warn';
    }
    return 'muted';
}
