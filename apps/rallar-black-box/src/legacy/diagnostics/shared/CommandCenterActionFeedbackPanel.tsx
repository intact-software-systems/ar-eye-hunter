import type { AuthSession } from '@shared/api/api-config.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import type { CommandCenterActionFeedback } from './action-feedback.ts';

export function CommandCenterActionFeedbackPanel({
    feedback,
    state,
    authSession,
}: {
    feedback: CommandCenterActionFeedback;
    state?: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const tone =
        feedback.state === 'success'
            ? 'good'
            : feedback.state === 'error'
              ? 'bad'
              : feedback.state === 'running'
                ? 'active'
                : 'muted';
    const label =
        feedback.state === 'success'
            ? 'success'
            : feedback.state === 'error'
              ? 'failed'
              : feedback.state === 'running'
                ? 'running'
                : 'idle';
    const title =
        feedback.state === 'idle'
            ? 'No action run yet'
            : (feedback.label ?? 'Action');
    const targetText = feedback.target
        ? String(
              redactRallarBlackBoxValue(
                  feedback.target,
                  uiRedactionOptions(state, authSession),
              ),
          )
        : '-';
    const statusText =
        feedback.status !== undefined
            ? `${feedback.status} ${feedback.statusText ?? ''}`.trim()
            : (feedback.statusText ?? '-');
    const message = feedback.message
        ? String(
              redactRallarBlackBoxValue(
                  feedback.message,
                  uiRedactionOptions(state, authSession),
              ),
          )
        : feedback.state === 'running'
          ? 'Waiting for completion.'
          : feedback.state === 'idle'
            ? 'Run an operation to see live feedback.'
            : '-';

    return (
        <section
            className={`rest-request-feedback ${tone}`}
            role="status"
            aria-live="polite"
        >
            <div>
                <span className={`pill ${tone}`}>{label}</span>
                <strong>{title}</strong>
                <small>
                    {feedback.atEpochMs ? formatTime(feedback.atEpochMs) : '-'}
                </small>
            </div>
            <dl>
                <div>
                    <dt>Target</dt>
                    <dd>{targetText}</dd>
                </div>
                <div>
                    <dt>Status</dt>
                    <dd>{statusText}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(feedback.durationMs)}</dd>
                </div>
                <div>
                    <dt>Message</dt>
                    <dd>{message}</dd>
                </div>
            </dl>
        </section>
    );
}
