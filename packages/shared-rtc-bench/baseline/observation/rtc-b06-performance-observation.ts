import type {
    RtcPerformanceObservationArchiveDto,
    RtcPerformanceObservationPrimaryDto,
    RtcPerformanceObservationRepeatDto,
    RtcPerformanceObservationSourceDto,
    RtcPerformanceObservationWorkflowDto
} from './rtc-performance-observation.ts';

export interface RtcB06PerformanceObservation {
    readonly schema: 'rallar.rtc-b06-performance-observation.v1';
    readonly observationId: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly source: RtcPerformanceObservationSourceDto;
    readonly workflow: RtcPerformanceObservationWorkflowDto;
    readonly primary: RtcPerformanceObservationPrimaryDto;
    readonly repeat: RtcPerformanceObservationRepeatDto;
}

export interface RtcB06PerformanceObservationIndexEntryDto {
    readonly schema: 'rallar.rtc-b06-performance-observation.index-entry.v1';
    readonly observation: RtcB06PerformanceObservation;
    readonly archive: RtcPerformanceObservationArchiveDto;
}
