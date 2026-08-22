import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/types.ts';
import { statusTone } from '../../shared/command-presentation.ts';
import { json } from '../../shared/json-presentation.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';

function activeDeadlineEpochMs(
    command:
        | (RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>)
        | undefined,
    startedAtEpochMs: number | undefined
): number | undefined {
    if (!command) {
        return undefined;
    }

    return (
        command.deadlineEpochMs ??
            (startedAtEpochMs !== undefined && command.timeoutMs !== undefined
                ? startedAtEpochMs + command.timeoutMs
                : undefined)
    );
}

export function ExecutionFocusPanel({
    result,
    activeCommand,
    startedAtEpochMs,
    now,
    redactionOptions
}: {
    result?: RallarBlackBoxTestResult;
    activeCommand?: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>;
    startedAtEpochMs?: number;
    now: number;
    redactionOptions: RallarBlackBoxTestRedactionOptions;
}) {
    const deadlineEpochMs = activeDeadlineEpochMs(
        activeCommand,
        startedAtEpochMs
    );
    const elapsedMs = activeCommand && startedAtEpochMs !== undefined
        ? Math.max(0, now - startedAtEpochMs)
        : undefined;
    const remainingMs = deadlineEpochMs !== undefined
        ? Math.max(0, deadlineEpochMs - now)
        : undefined;
    const retryState = activeCommand?.metadata?.retry ??
        activeCommand?.metadata?.retries ??
        'none';

    return (
        <section className="panel focus-panel">
            <div className="panel-heading">
                <h2>Current Focus</h2>
                <span
                    className={`pill ${result ? statusTone(result.status) : activeCommand ? 'active' : 'muted'}`}
                >
                    {result?.status ?? (activeCommand ? 'running' : 'none')}
                </span>
            </div>
            {activeCommand && (
                <div className="active-command">
                    <span>Executing</span>
                    <strong>{activeCommand.commandId}</strong>
                    <small>{activeCommand.kind}</small>
                </div>
            )}
            <dl className="result-summary">
                <div>
                    <dt>Command</dt>
                    <dd>
                        {result?.commandId ?? activeCommand?.commandId ?? '-'}
                    </dd>
                </div>
                <div>
                    <dt>Kind</dt>
                    <dd>{result?.kind ?? activeCommand?.kind ?? '-'}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(result?.durationMs ?? elapsedMs)}</dd>
                </div>
                <div>
                    <dt>Deadline</dt>
                    <dd>
                        {deadlineEpochMs ? formatTime(deadlineEpochMs) : '-'}
                    </dd>
                </div>
                <div>
                    <dt>Remaining</dt>
                    <dd>{formatDuration(remainingMs)}</dd>
                </div>
                <div>
                    <dt>Retry</dt>
                    <dd>{String(retryState)}</dd>
                </div>
                <div>
                    <dt>Ended</dt>
                    <dd>{formatTime(result?.endedAtEpochMs)}</dd>
                </div>
            </dl>
            <pre className="json-block">
                {json(
                    redactRallarBlackBoxValue(
                        result ?? activeCommand,
                        redactionOptions,
                    ),
                )}
            </pre>
        </section>
    );
}
