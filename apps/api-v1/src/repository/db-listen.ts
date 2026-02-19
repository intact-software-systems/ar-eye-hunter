import postgres from "postgres";
import {tryWith} from "@shared/resilience/TryWith.ts";
import {myPublisherId, PublishMessage} from "./db-notify.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

export const listenSql =
    postgres(
        DATABASE_URL,
        {
            max: 1,
            idle_timeout: 0
        }
    );

export async function startListening(
    channel: string,
    onMessage: (payload: PublishMessage) => void
) {
    await tryWith(
        async () => {
            return await listenSql
                .listen(
                    channel,
                    (payload: string) => {
                        console.log(`[LISTEN ${channel}]`, payload)

                        const publisherPayload: PublishMessage = JSON.parse(payload);

                        if (publisherPayload.publisherId === myPublisherId) {
                            // I sent it so ignore it
                            console.log(`Ignoring my own message: ${payload}`)
                            return;
                        }

                        try {
                            onMessage(publisherPayload);
                        } catch (e) {
                            console.error(e);
                        }
                    })
        }
    )

    console.log(`Listening on channel '${channel}'`)
}