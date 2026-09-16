import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { UseRallarServerControllerInput } from './rallar-server-contracts.ts';
import { RallarServerView } from './rallar-server-view.tsx';
import { useRallarServerController } from './use-rallar-server-controller.ts';

export interface RallarServerPanelProps extends UseRallarServerControllerInput {
    readonly control: RallarBlackBoxControlSnapshot;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
}

export function RallarServerPanel(props: RallarServerPanelProps) {
    const model = useRallarServerController(props);
    return (
        <RallarServerView
            state={props.state}
            authSession={props.authSession}
            control={props.control}
            onGlobalValueChange={props.onGlobalValueChange}
            model={model}
        />
    );
}
