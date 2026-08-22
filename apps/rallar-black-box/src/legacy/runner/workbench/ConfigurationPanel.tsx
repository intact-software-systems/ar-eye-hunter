import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { rallarBlackBoxProviderModeFromConfig } from '../../../runtime-store.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';

export function ConfigurationPanel({ state }: { state: RallarBlackBoxTestState; }) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);

    return (
        <section className="panel config-panel">
            <div className="panel-heading">
                <h2>Configuration</h2>
                <span className="pill muted">redacted</span>
            </div>
            <dl className="config-list">
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>API base</dt>
                    <dd>{config?.apiBaseUrl ?? 'not configured'}</dd>
                </div>
                <div>
                    <dt>Transport</dt>
                    <dd>{config?.transport ?? 'not selected'}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{config?.roomId ?? 'not joined'}</dd>
                </div>
                <div>
                    <dt>Control mode</dt>
                    <dd>{String(config?.control?.mode ?? 'local')}</dd>
                </div>
            </dl>
            <pre className="json-block">{redactedJson(config, state)}</pre>
        </section>
    );
}
