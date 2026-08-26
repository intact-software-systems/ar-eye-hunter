// Parsed as a source override at GROUP_OWNER_PATH by mutation-routing analyzer tests.
export const GROUP_OWNER_FIXTURE_SOURCE = `
import { AppInboxType } from '../app-inbox/app-inbox-contracts.ts';
import { processGroupSessionCleanup } from './presence/group-presence-service.ts';
import { GROUP_MUTATION_INBOX_TYPES } from './group-state-inbox-contracts.ts';

export class GroupStateInboxService {
    private registerMessageHandlers(): void {
        for (
            const type of GROUP_MUTATION_INBOX_TYPES.filter(
                (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
            )
        ) {
            this.handlers.registerHandler({
                type,
                decodeCommand: (value) => value,
                encodeResult: (result) => result,
                handle: async (_command, context) =>
                    await this.groupStateInboxHandler.processGroupStateMutation(context)
            });
        }
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            decodeCommand: (value) => value,
            encodeResult: (result) => result,
            handle: async (payload, context) =>
                await processGroupSessionCleanup({ payload, context })
        });
    }
}
`;
