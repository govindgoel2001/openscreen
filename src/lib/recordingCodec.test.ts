import { describe, expect, it } from "vitest";
import { FALLBACK_RECORDING_MIME, selectRecordingMimeType } from "./recordingCodec";

const supporting =
	(...supported: string[]) =>
	(type: string) =>
		supported.includes(type);

describe("selectRecordingMimeType", () => {
	it("prefers H.264 when the platform supports it", () => {
		expect(
			selectRecordingMimeType(
				supporting("video/webm;codecs=av1", "video/webm;codecs=vp9", "video/webm;codecs=h264"),
			),
		).toBe("video/webm;codecs=h264");
	});

	it("does not pick AV1 while any other codec is available", () => {
		expect(
			selectRecordingMimeType(supporting("video/webm;codecs=av1", "video/webm;codecs=vp8")),
		).toBe("video/webm;codecs=vp8");
	});

	it("still takes AV1 when it is the only codec on offer", () => {
		expect(selectRecordingMimeType(supporting("video/webm;codecs=av1"))).toBe(
			"video/webm;codecs=av1",
		);
	});

	it("falls back to plain webm when nothing is reported as supported", () => {
		expect(selectRecordingMimeType(() => false)).toBe(FALLBACK_RECORDING_MIME);
	});
});
