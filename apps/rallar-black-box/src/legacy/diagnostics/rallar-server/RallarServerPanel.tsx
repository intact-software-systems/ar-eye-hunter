import { RallarServerView } from './RallarServerView.tsx';
import { useRallarServerController, type UseRallarServerControllerInput } from './use-rallar-server-controller.ts';

export function RallarServerPanel(props: UseRallarServerControllerInput) {
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
