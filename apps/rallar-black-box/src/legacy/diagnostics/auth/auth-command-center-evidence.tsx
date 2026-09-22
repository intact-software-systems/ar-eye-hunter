import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { redactedJson, uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { formatDuration, formatRelativeDuration, formatTime } from '../../shared/time-format.ts';
import type { AuthCommandCenterModel } from './auth-command-center-contracts.ts';

interface AuthCommandCenterEvidenceProps {
    readonly model: AuthCommandCenterModel;
    readonly state: RallarBlackBoxTestState;
    /** Absent while the browser is signed out. */
    readonly authSession: AuthSession | undefined;
}

export function AuthCommandCenterEvidence(props: AuthCommandCenterEvidenceProps) {
    const { model, state, authSession } = props;
    return (
        <>
            <AuthSessionList {...props} />
            <div className="command-center-status auth-session-guidance" role="note">
                Ordinary same-origin tabs share localStorage `auth.session`. Agent tabs opened from Connect Agents use
                one-time links and sessionStorage so the same logged-in user can create distinct targetable browser
                sessions.
            </div>
            {model.busyAction && (
                <div className="command-center-status" role="status">
                    {model.busyAction}
                </div>
            )}
            {model.localError && (
                <div className="workbench-error" role="status">
                    {redactRallarBlackBoxValue(
                        model.localError,
                        uiRedactionOptions(state, authSession, [model.password])
                    )}
                </div>
            )}
            <AuthActionList {...props} />
        </>
    );
}

function AuthSessionList({ model, authSession }: AuthCommandCenterEvidenceProps) {
    const entries: ReadonlyArray<readonly [string, string]> = [
        ['Provider', model.providerMode],
        ['User', authSession?.username ?? '-'],
        ['Client', authSession?.clientId ?? '-'],
        ['Session', authSession?.sessionId ?? '-'],
        ['Token', authSession?.accessToken ? 'redacted' : '-'],
        ['Session expires', formatTime(authSession?.expiresAtEpochMs)],
        ['Session TTL', formatRelativeDuration(model.sessionExpiresInMs)],
        ['WS ticket', model.ticket ? 'redacted' : '-'],
        ['Ticket expires', formatTime(model.ticket?.expiresAtEpochMs)],
        ['Ticket TTL', formatRelativeDuration(model.wsTicketExpiresInMs)]
    ];
    return (
        <dl className="config-list auth-session-list">
            {entries.map(([term, value]) => (
                <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

function AuthActionList({ model, state, authSession }: AuthCommandCenterEvidenceProps) {
    return (
        <div className="command-center-action-list">
            {model.actions.length === 0 && <div className="empty-state">No auth actions yet</div>}
            {model.actions.slice().reverse().map((action) => (
                <article className="command-center-action-row" key={action.actionId}>
                    <div>
                        <strong>{action.label}</strong>
                        <small>
                            {formatTime(action.atEpochMs)} - {formatDuration(action.durationMs)}
                        </small>
                    </div>
                    <span className={`pill ${action.ok ? 'good' : 'bad'}`}>
                        {action.status || action.errorKind || 'local'}
                    </span>
                    <pre className="mini-json">
                        {redactedJson(action.bodyJson ?? action.errorKind ?? action.statusText, state, authSession, [
                            model.password
                        ])}
                    </pre>
                </article>
            ))}
        </div>
    );
}
