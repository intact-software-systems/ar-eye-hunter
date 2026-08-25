import {
    useWebSocketCommandCenterController,
    type UseWebSocketCommandCenterControllerInput
} from './use-websocket-command-center-controller.ts';
import { WebSocketCommandCenterView } from './view/websocket-command-center-view.tsx';

export interface WebSocketCommandCenterPanelProps extends UseWebSocketCommandCenterControllerInput {
    readonly busy: boolean;
    readonly onSelectCommand: (commandId: string) => void;
}

export function WebSocketCommandCenterPanel(props: WebSocketCommandCenterPanelProps) {
    const model = useWebSocketCommandCenterController(props);
    return (
        <WebSocketCommandCenterView
            state={props.state}
            authSession={props.authSession}
            browserStatus={props.browserStatus}
            busy={props.busy}
            model={model}
        />
    );
}
