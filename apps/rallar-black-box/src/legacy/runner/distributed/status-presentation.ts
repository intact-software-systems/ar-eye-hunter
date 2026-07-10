import type { RallarBlackBoxTestSeverity } from '@shared-test/rallar-bb-test/types.ts';
import type {
    DistributedRunAnalysisReport,
    DistributedRunProgressStatus,
} from '../../../distributed-recipes.ts';

const RTC_STREAM_PERFORMANCE_CATEGORY = 'rtc-stream-performance';

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

export function distributedFailureCategoryTone(
    category: DistributedRunAnalysisReport['nextActions'][number]['category'],
): string {
    if (
        category === 'command' ||
        category === 'diagnostic' ||
        category === RTC_STREAM_PERFORMANCE_CATEGORY
    ) {
        return 'bad';
    }
    if (
        category === 'targeting' ||
        category === 'readiness' ||
        category === 'barrier'
    ) {
        return 'warn';
    }
    if (category === 'runtime') {
        return 'active';
    }
    return 'muted';
}

export function distributedDiagnosticTone(
    severity: RallarBlackBoxTestSeverity,
): string {
    if (severity === 'error') {
        return 'bad';
    }
    if (severity === 'warning') {
        return 'warn';
    }
    return 'muted';
}

export function distributedCompositeStatusTone(status: string): string {
    if (status === 'ok' || status === 'passed') {
        return 'good';
    }
    if (status === 'failed') {
        return 'bad';
    }
    if (status === 'cancelled') {
        return 'warn';
    }
    if (status === 'skipped' || status === 'empty') {
        return 'muted';
    }
    return 'active';
}
