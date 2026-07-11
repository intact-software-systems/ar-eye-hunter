import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';

export function BootstrapPanel({
    bootstrap,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
}) {
    return (
        <section className="panel bootstrap-panel">
            <div className="panel-heading">
                <h2>Bootstrap</h2>
                <span
                    className={`pill ${bootstrap.mode === 'control-agent' ? 'active' : 'muted'}`}
                >
                    {bootstrap.mode}
                </span>
            </div>
            <dl className="config-grid">
                <div>
                    <dt>Source</dt>
                    <dd>{bootstrap.source}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{bootstrap.providerMode}</dd>
                </div>
                <div>
                    <dt>Auto Connect</dt>
                    <dd>{bootstrap.autoConnect ? 'enabled' : 'disabled'}</dd>
                </div>
                <div>
                    <dt>Control URL</dt>
                    <dd>{bootstrap.controlUrl}</dd>
                </div>
                <div>
                    <dt>Run</dt>
                    <dd>{bootstrap.runId ?? 'generated'}</dd>
                </div>
                <div>
                    <dt>Agent</dt>
                    <dd>{bootstrap.agentId}</dd>
                </div>
            </dl>
        </section>
    );
}
