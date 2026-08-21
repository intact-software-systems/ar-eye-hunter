import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecipeConsoleControlFleetCapability } from '../control/control-api.ts';
import type { RecipeConsoleControlFleetApi } from '../control/control-fleet-api.ts';
import { downloadFleetArtifactEnvelope } from './fleet-artifact-download.ts';
import { deriveFleetArtifactModel, type FleetArtifactModel } from './fleet-artifact-model.ts';

type FleetArtifactState =
    | Readonly<{ status: 'idle'; }>
    | Readonly<{
        status: 'loading' | 'ready' | 'error';
        reportId: string;
        capabilityGeneration: RecipeConsoleControlFleetCapability['generation'];
        model?: FleetArtifactModel;
        message?: string;
    }>;

type LoadedFleetApi = Readonly<{
    generation: RecipeConsoleControlFleetCapability['generation'];
    api: RecipeConsoleControlFleetApi;
}>;

export function useFleetArtifact(
    input: Readonly<{
        capability?: RecipeConsoleControlFleetCapability;
        selectedReportId?: string;
    }>
) {
    const [state, setState] = useState<FleetArtifactState>({ status: 'idle' });
    const loadedRef = useRef<LoadedFleetApi | undefined>(undefined);
    const requestRef = useRef<AbortController | undefined>(undefined);
    const generationRef = useRef(0);

    useEffect(() => {
        generationRef.current += 1;
        requestRef.current?.abort();
        requestRef.current = undefined;
        loadedRef.current?.api.clearSelectedReportBundle();
        if (loadedRef.current?.generation !== input.capability?.generation) {
            loadedRef.current = undefined;
        }
        setState({ status: 'idle' });
    }, [input.capability?.generation, input.selectedReportId]);
    useEffect(() => () => {
        generationRef.current += 1;
        requestRef.current?.abort();
        loadedRef.current?.api.clearSelectedReportBundle();
    }, []);

    const load = useCallback(async () => {
        if (!input.capability || !input.selectedReportId) {
            return;
        }
        const capability = input.capability;
        const reportId = input.selectedReportId;
        const currentModel = state.status !== 'idle' &&
                state.capabilityGeneration === capability.generation &&
                state.reportId === reportId
            ? state.model
            : undefined;
        const generation = ++generationRef.current;
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setState({
            status: 'loading',
            capabilityGeneration: capability.generation,
            reportId,
            ...(currentModel ? { model: currentModel } : {})
        });
        try {
            const api = loadedRef.current?.generation === capability.generation
                ? loadedRef.current.api
                : await capability.load();
            if (controller.signal.aborted || generation !== generationRef.current) {
                return;
            }
            loadedRef.current = {
                generation: capability.generation,
                api
            };
            const bundle = await api.selectReportBundle({
                distributedRunId: reportId,
                signal: controller.signal
            });
            if (controller.signal.aborted || generation !== generationRef.current) {
                return;
            }
            setState({
                status: 'ready',
                capabilityGeneration: capability.generation,
                reportId,
                model: deriveFleetArtifactModel(bundle)
            });
        }
        catch (error) {
            if (controller.signal.aborted || generation !== generationRef.current) {
                return;
            }
            setState({
                status: 'error',
                capabilityGeneration: capability.generation,
                reportId,
                ...(currentModel ? { model: currentModel } : {}),
                message: error instanceof Error ? error.message : String(error)
            });
        }
        finally {
            if (requestRef.current === controller) {
                requestRef.current = undefined;
            }
        }
    }, [input.capability, input.selectedReportId, state]);
    const stateMatchesSelection = state.status !== 'idle' &&
        state.capabilityGeneration === input.capability?.generation &&
        state.reportId === input.selectedReportId;
    const model = stateMatchesSelection ? state.model : undefined;
    const message = stateMatchesSelection ? state.message : undefined;
    const status = stateMatchesSelection ? state.status : 'idle';
    const exportEnvelope = useCallback(() => {
        if (model) {
            downloadFleetArtifactEnvelope(model.bundle);
        }
    }, [model]);

    return { status, model, message, load, exportEnvelope } as const;
}
