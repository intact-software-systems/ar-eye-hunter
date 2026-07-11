export function LegacyIsolationSamples() {
    return (
        <section className="panel" data-isolation-legacy-panel>
            <h1>Legacy samples</h1>
            <span className="pill active">Connected</span>
            <div className="metric"><span>Rooms</span><strong>2</strong></div>
            <label>Room <input defaultValue="seed-room" /></label>
            <table><tbody><tr><td>seed-agent-a</td><td>online</td></tr></tbody></table>
            <div className="modal-card">Legacy dialog geometry</div>
        </section>
    );
}
