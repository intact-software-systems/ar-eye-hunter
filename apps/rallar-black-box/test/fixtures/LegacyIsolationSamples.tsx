export function LegacyIsolationSamples() {
    return (
        <section className="panel" data-isolation-legacy-panel>
            <h1>Legacy samples</h1>
            <span className="pill active" data-isolation-legacy-pill>Connected</span>
            <div className="metric" data-isolation-legacy-metric>
                <span>Rooms</span>
                <strong>2</strong>
            </div>
            <label data-isolation-legacy-form>
                Room <input defaultValue="seed-room" />
            </label>
            <table data-isolation-legacy-table>
                <tbody>
                    <tr>
                        <td>seed-agent-a</td>
                        <td>online</td>
                    </tr>
                </tbody>
            </table>
            <div className="modal-card" data-isolation-legacy-dialog>Legacy dialog geometry</div>
        </section>
    );
}
