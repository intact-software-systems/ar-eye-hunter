import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { TuneInspector } from './TuneInspector.tsx';
import {
    tuneInspectionAuthority,
    tuneInspectionLabel,
    type TuneInspection,
} from './tune-inspection.ts';
import type { TuneSourceModel } from './tune-source-model.ts';

export function useTuneInspectionHost({
    source,
    onInspect,
    onInspectorChange,
    onSelectionLabelChange,
}: Readonly<{
    source: TuneSourceModel;
    onInspect(trigger: HTMLButtonElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>) {
    const inspectionAuthority = tuneInspectionAuthority(source);
    const [scopedInspection, setScopedInspection] = useState<Readonly<{
        authority: string;
        selection: TuneInspection;
    }>>();
    const inspection = scopedInspection?.authority === inspectionAuthority
        ? scopedInspection.selection
        : undefined;
    const inspector = useMemo(() => inspection ? (
        <TuneInspector selection={inspection} source={source} />
    ) : undefined, [inspection, source]);
    const inspect = useCallback((
        next: TuneInspection,
        trigger: HTMLButtonElement,
    ) => {
        setScopedInspection({
            authority: inspectionAuthority,
            selection: next,
        });
        onInspect(trigger);
    }, [inspectionAuthority, onInspect]);

    useLayoutEffect(() => {
        onInspectorChange(inspector);
        onSelectionLabelChange(inspection
            ? tuneInspectionLabel(inspection)
            : undefined);
    }, [
        inspection,
        inspector,
        onInspectorChange,
        onSelectionLabelChange,
    ]);
    useEffect(() => {
        if (
            scopedInspection &&
            scopedInspection.authority !== inspectionAuthority
        ) {
            setScopedInspection(undefined);
        }
    }, [inspectionAuthority, scopedInspection]);
    useEffect(() => () => {
        onInspectorChange(undefined);
        onSelectionLabelChange(undefined);
    }, [onInspectorChange, onSelectionLabelChange]);

    return inspect;
}
