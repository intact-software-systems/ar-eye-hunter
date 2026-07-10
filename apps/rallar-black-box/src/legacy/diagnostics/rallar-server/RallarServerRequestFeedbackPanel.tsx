import type { AuthSession } from '@shared/api/api-config.ts';
import {
    redactRallarServerText,
    redactRallarServerUrl,
} from '../../../rallar-server-workbench.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import type { RallarServerRequestFeedback } from './rallar-server-contracts.ts';

export function RallarServerRequestFeedbackPanel({
    feedback,
    authSession,
}: {
    feedback: RallarServerRequestFeedback;
    authSession?: AuthSession;
}) {
    const tone =
        feedback.state === 'success'
            ? 'good'
            : feedback.state === 'error'
              ? 'bad'
              : feedback.state === 'sending'
                ? 'active'
                : 'muted';
    const label =
        feedback.state === 'success'
            ? 'success'
            : feedback.state === 'error'
              ? 'failed'
              : feedback.state === 'sending'
                ? 'sending'
                : 'idle';
    const title =
        feedback.state === 'idle'
            ? 'No request sent yet'
            : `${feedback.method ?? 'Request'} ${feedback.state}`;
    const statusText =
        feedback.status !== undefined
            ? `${feedback.status} ${feedback.statusText ?? ''}`.trim()
            : (feedback.errorKind ?? '-');
    const urlText = feedback.url
        ? redactRallarServerUrl(feedback.url, authSession)
        : (feedback.path ?? '-');
    const message = feedback.message
        ? redactRallarServerText(feedback.message, authSession)
        : feedback.state === 'sending'
          ? 'Waiting for Rallar Server response.'
          : feedback.state === 'idle'
            ? 'Configure an endpoint and send a request.'
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
                    <dt>Endpoint</dt>
                    <dd>{urlText}</dd>
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
