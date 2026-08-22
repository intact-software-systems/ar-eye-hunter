import { selectRallarBlackBoxFirstFailure } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';

export function FailurePanel({
    state,
    authSession
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const firstFailure = selectRallarBlackBoxFirstFailure(state);

    return (
        <section className="panel failure-panel">
            <div className="panel-heading">
                <h2>Failure Focus</h2>
                <span className={`pill ${firstFailure ? 'bad' : 'good'}`}>
                    {firstFailure ? 'failed' : 'clear'}
                </span>
            </div>
            <div
                className={`failure-focus ${firstFailure ? 'has-failure' : ''}`}
            >
                <span>First failure</span>
                <strong>{firstFailure?.commandId ?? 'none'}</strong>
                <small>
                    {firstFailure?.error?.message ??
                        'No failed command recorded'}
                </small>
            </div>
            <pre className="json-block">
                {redactedJson(firstFailure ?? { ok: true }, state, authSession)}
            </pre>
        </section>
    );
}
