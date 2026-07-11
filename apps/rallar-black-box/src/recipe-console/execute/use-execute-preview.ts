import { useState } from 'react';
import type { ExecutePreviewModel } from '../data/recipe-console-models.ts';

export type ExecutePreviewStatus = 'idle' | 'staged-preview' | 'started-preview';

export function useExecutePreview(model: ExecutePreviewModel) {
    const [query, setQuery] = useState('');
    const [selectedRecipeId, setSelectedRecipeId] = useState(
        model.selectedFixture.fixtureId,
    );
    const [selectedTargetIds, setSelectedTargetIds] = useState<readonly string[]>(
        model.defaultTargetIds,
    );
    const [previewStatus, setPreviewStatus] = useState<ExecutePreviewStatus>('idle');
    const [preflightExpanded, setPreflightExpanded] = useState(true);

    function selectRecipe(recipeId: string): void {
        setSelectedRecipeId(recipeId);
        setPreviewStatus('idle');
    }

    function toggleTarget(agentId: string): void {
        setSelectedTargetIds(current => current.includes(agentId)
            ? current.filter(id => id !== agentId)
            : [...current, agentId]);
        setPreviewStatus('idle');
    }

    return {
        query,
        selectedRecipeId,
        selectedTargetIds,
        previewStatus,
        preflightExpanded,
        setQuery,
        selectRecipe,
        toggleTarget,
        setPreflightExpanded,
        stagePreview: () => setPreviewStatus('staged-preview'),
        startPreview: () => setPreviewStatus('started-preview'),
    } as const;
}
