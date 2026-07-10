import {
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    validateJsonSchema,
} from '@shared-test/rallar-bb-test/schema.ts';
import {
    distributedRecipeCommandPreview,
    distributedRecipePreflight,
    type DistributedRecipeCatalogItem,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    normalizeRallarBlackBoxRtcRealtimeDurationSeconds,
} from '../../../../recipe-fixtures.ts';
import { validateSchemaAuthoringValue } from '../../../../schema-authoring.ts';
import { SchemaCapabilitySummary } from '../../../shared/schema/SchemaAuthoringPanel.tsx';
import { DistributedRecipePreflightPanel } from '../DistributedRecipePreflightPanel.tsx';

type DistributedRecipeCatalogPanelProps = Readonly<{
    query: string;
    profile: string;
    profileOptions: readonly string[];
    rtcRealtimeSelected: boolean;
    rtcRealtimeDurationSeconds: number;
    rtcRealtimeFrameCount: number;
    filteredRecipes: readonly DistributedRecipeCatalogItem[];
    selectedRecipeIds: readonly string[];
    onQueryChange(value: string): void;
    onProfileChange(value: string): void;
    onRtcRealtimeDurationChange(value: number): void;
    onToggleRecipe(itemId: string): void;
}>;

export function DistributedRecipeCatalogPanel(props: DistributedRecipeCatalogPanelProps) {
    return (
        <section className="distributed-subpanel distributed-recipes-catalog">
            <div className="section-heading">
                <h3>Recipe Catalog</h3>
                <span>{props.filteredRecipes.length} visible</span>
            </div>
            <div className="shared-test-filter-grid distributed-filter-grid">
                <label className="field">
                    <span>Search</span>
                    <input
                        value={props.query}
                        onChange={(event) =>
                            props.onQueryChange(event.target.value)
                        }
                        placeholder="recipe, profile, command"
                    />
                </label>
                <label className="field">
                    <span>Profile</span>
                    <select
                        value={props.profile}
                        onChange={(event) =>
                            props.onProfileChange(event.target.value)
                        }
                    >
                        <option value="">All profiles</option>
                        {props.profileOptions.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                {props.rtcRealtimeSelected && (
                    <label className="field">
                        <span>RTC Realtime Length Seconds</span>
                        <input
                            type="number"
                            min={RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS}
                            max={RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS}
                            value={props.rtcRealtimeDurationSeconds}
                            onChange={(event) => {
                                props.onRtcRealtimeDurationChange(
                                    normalizeRallarBlackBoxRtcRealtimeDurationSeconds(
                                        event.target.value,
                                    ),
                                );
                            }}
                        />
                        <small>
                            {props.rtcRealtimeFrameCount} position frames at{' '}
                            {RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ} Hz.
                        </small>
                    </label>
                )}
            </div>
            <div className="distributed-recipe-list">
                {props.filteredRecipes.map((item) => {
                    const selected = props.selectedRecipeIds.includes(
                        item.itemId,
                    );
                    const validation = validateJsonSchema(
                        RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
                        item.recipe,
                    );
                    const authoringValidation = validateSchemaAuthoringValue(
                        'recipe',
                        item.recipe,
                    );
                    const commandPreview = distributedRecipeCommandPreview(
                        item.recipe,
                    );
                    const preflight = distributedRecipePreflight(item.recipe);
                    return (
                        <article
                            className={`distributed-recipe-row ${selected ? 'selected' : ''}`}
                            key={item.itemId}
                        >
                            <label>
                                <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() =>
                                        props.onToggleRecipe(item.itemId)
                                    }
                                />
                                <span>
                                    <strong>{item.title}</strong>
                                    <small>
                                        {item.recipe.recipeId} -{' '}
                                        {commandPreview.label}
                                    </small>
                                </span>
                            </label>
                            <p>{item.description}</p>
                            <div className="badge-list">
                                <span
                                    className={`pill ${item.live ? 'warn' : 'muted'}`}
                                >
                                    {item.live ? 'live traffic' : 'local'}
                                </span>
                                <span
                                    className={`pill ${validation.ok ? 'good' : 'bad'}`}
                                >
                                    {validation.ok
                                        ? 'schema valid'
                                        : 'schema invalid'}
                                </span>
                                <span
                                    className={`pill ${preflight.errors.length > 0 ? 'bad' : preflight.warnings.length > 0 ? 'warn' : 'good'}`}
                                >
                                    preflight{' '}
                                    {preflight.errors.length > 0
                                        ? 'blocked'
                                        : preflight.warnings.length > 0
                                          ? 'warnings'
                                          : 'clear'}
                                </span>
                                {item.profiles.map((entry) => (
                                    <span className="pill muted" key={entry}>
                                        {entry}
                                    </span>
                                ))}
                                {preflight.serviceBadges.map((badge) => (
                                    <span
                                        className={`pill ${badge.tone}`}
                                        key={badge.label}
                                    >
                                        {badge.label}
                                    </span>
                                ))}
                                {commandPreview.effectiveFrameCount !==
                                    undefined && (
                                    <span className="pill active">
                                        {commandPreview.effectiveFrameCount}{' '}
                                        effective frames
                                    </span>
                                )}
                            </div>
                            <details>
                                <summary>Prerequisites</summary>
                                <ul>
                                    {item.prerequisites.map((requirement) => (
                                        <li key={requirement}>{requirement}</li>
                                    ))}
                                </ul>
                            </details>
                            <details>
                                <summary>Capabilities</summary>
                                <SchemaCapabilitySummary
                                    validation={authoringValidation}
                                />
                            </details>
                            <details open={selected}>
                                <summary>Preflight</summary>
                                <DistributedRecipePreflightPanel
                                    preflight={preflight}
                                />
                            </details>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}
