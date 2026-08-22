import { RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF } from '../../../shared-test-handoff-fixtures.ts';
import { SharedTestArtifactImportPanel } from './SharedTestArtifactImportPanel.tsx';
import { SharedTestCatalogPanel } from './SharedTestCatalogPanel.tsx';

export function SharedTestPanel() {
    return (
        <div className="shared-test-stack">
            <SharedTestCatalogPanel />
            <SharedTestArtifactImportPanel />
            <section className="panel shared-test-coverage-panel">
                <div className="panel-heading">
                    <h2>Coverage Ownership</h2>
                    <span>
                        {RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF.length} owners
                    </span>
                </div>
                <div className="coverage-owner-grid">
                    {RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF.map(
                        (owner) => (
                            <article
                                className="coverage-owner-row"
                                key={owner.owner}
                            >
                                <h3>{owner.owner}</h3>
                                <strong>Owns</strong>
                                <ul>
                                    {owner.owns.map((item) => <li key={item}>{item}</li>)}
                                </ul>
                                <strong>Does not own</strong>
                                <ul>
                                    {owner.doesNotOwn.map((item) => <li key={item}>{item}</li>)}
                                </ul>
                            </article>
                        )
                    )}
                </div>
            </section>
        </div>
    );
}
