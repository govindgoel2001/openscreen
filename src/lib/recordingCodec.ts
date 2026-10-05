/**
 * Chooses the container and codec MediaRecorder captures with.
 *
 * H.264 comes first because it is the only codec with a hardware encoder on
 * essentially every machine that runs this app. AV1 is last: browsers report it
 * as supported even where the GPU has no AV1 encoder, and the software fallback
 * cannot keep up with 1080p60, so it silently drops frames and lets the video
 * fall behind the audio. Export re-encodes to H.264 regardless, so recording in
 * H.264 also avoids a codec change in the middle of the pipeline.
 */
export const RECORDING_MIME_PREFERENCE = [
	"video/webm;codecs=h264",
	"video/webm;codecs=vp9",
	"video/webm;codecs=vp8",
	"video/webm;codecs=av1",
	"video/webm",
] as const;

export const FALLBACK_RECORDING_MIME = "video/webm";

export function selectRecordingMimeType(
	isTypeSupported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string {
	return RECORDING_MIME_PREFERENCE.find((type) => isTypeSupported(type)) ?? FALLBACK_RECORDING_MIME;
}
