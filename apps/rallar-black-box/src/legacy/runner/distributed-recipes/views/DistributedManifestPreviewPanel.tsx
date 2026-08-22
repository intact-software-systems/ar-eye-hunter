import type {
    DistributedRecipeCatalogItem,
    DistributedRecipePreflightSummary
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { SchemaAuthoringValidation } from '../../../../schema-authoring.ts';
import { json } from '../../../shared/json-presentation.ts';
import { Metric } from '../../../shared/Metric.tsx';
import { SchemaAuthoringPanel } from '../../../shared/schema/SchemaAuthoringPanel.tsx';
import { DistributedRecipePreflightPanel } from '../DistributedRecipePreflightPanel.tsx';

type DistributedManifestPreviewPanelProps = Readonly<{
    manifestValidation?: string;
    selectedRecipePreflights: readonly Readonly<{
        item: DistributedRecipeCatalogItem;
        preflight: DistributedRecipePreflightSummary;
    }>[];
    selectedPreflightEffectiveOperations: number;
    selectedPreflightWarnings: number;
    selectedPreflightErrors: number;
    manifest?: RallarBlackBoxDistributedRunManifest;
    manifestAuthoringValidation?: SchemaAuthoringValidation;
}>;

export function DistributedManifestPreviewPanel(props: DistributedManifestPreviewPanelProps) {
    return (
        <section className="distributed-subpanel distributed-manifest-panel">
            <div className="section-heading">
                <h3>Manifest Preview</h3>
                <span
                    className={`pill ${props.manifestValidation ? 'bad' : 'good'}`}
                >
                    {props.manifestValidation ? 'invalid' : 'valid'}
                </span>
            </div>
            {props.selectedRecipePreflights.length > 0 && (
                <div
                    className="distributed-selected-preflight"
                    aria-label="Selected recipe preflight"
                >
                    <div className="distributed-preflight-metrics">
                        <Metric
                            label="Selected recipes"
                            value={String(props.selectedRecipePreflights.length)}
                            tone="active"
                        />
                        <Metric
                            label="Effective ops"
                            value={String(
                                props.selectedPreflightEffectiveOperations
                            )}
                            tone="active"
                        />
                        <Metric
                            label="Warnings"
                            value={String(props.selectedPreflightWarnings)}
                            tone={props.selectedPreflightWarnings > 0
                                ? 'warn'
                                : 'good'}
                        />
                        <Metric
                            label="Errors"
                            value={String(props.selectedPreflightErrors)}
                            tone={props.selectedPreflightErrors > 0
                                ? 'bad'
                                : 'good'}
                        />
                    </div>
                    {props.selectedRecipePreflights.map((entry) => (
                        <details key={entry.item.itemId} open>
                            <summary>{entry.item.title} preflight</summary>
                            <DistributedRecipePreflightPanel
                                preflight={entry.preflight}
                                compact
                            />
                        </details>
                    ))}
                </div>
            )}
            <pre className="json-block">{json(props.manifest)}</pre>
            {props.manifestAuthoringValidation && (
                <SchemaAuthoringPanel
                    validation={props.manifestAuthoringValidation}
                />
            )}
        </section>
    );
}
