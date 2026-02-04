import {ResourceEntry} from "./ResourceEntry.ts";

export interface EnqueueResourceEntryController {
    putIfAbsent(resourceEntry: ResourceEntry): ResourceEntry;
    put(resourceEntry: ResourceEntry): ResourceEntry | undefined;
}