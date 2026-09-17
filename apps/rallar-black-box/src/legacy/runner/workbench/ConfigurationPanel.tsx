import { resolveRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/client-defaults.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';

export function ConfigurationPanel({ state }: { state: RallarBlackBoxTestState; }) {
    const config = getRallarBlackBoxCurrentConfig(state);
    const providerMode = resolveRallarBlackBoxConfigProviderMode(config);

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
