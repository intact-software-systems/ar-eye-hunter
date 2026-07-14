import { RoomsClientsView } from './RoomsClientsView.tsx';
import {
    type UseRoomsClientsControllerInput,
    useRoomsClientsController,
} from './use-rooms-clients-controller.ts';

export function RoomsClientsPanel(input: UseRoomsClientsControllerInput) {
    const model = useRoomsClientsController(input);
    return (
        <RoomsClientsView
            state={input.state}
            bootstrap={input.bootstrap}
            authSession={input.authSession}
            model={model}
        />
    );
}
