import { describe, expect, it } from "vitest";
import { buildAVCCodecString, shouldFailDecodeEndedEarly } from "./streamingDecoder";

describe("shouldFailDecodeEndedEarly", () => {
	it("does not fail once every segment has been satisfied", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(false);
	});

	it("fails when decode stops far before the required end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 10,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});

	it("fails when no frame could be decoded for a non-empty timeline", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: null,
				requiredEndSec: 1,
			}),
		).toBe(true);
	});

	it("fails when the decoder has not reached the reported stream end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 4.9,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});
});

describe("buildAVCCodecString", () => {
	it("reads profile, compatibility and level out of the avcC record", () => {
		const record = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff]);
		expect(buildAVCCodecString(record)).toBe("avc1.640028");
	});

	it("pads single-digit bytes", () => {
		const record = new Uint8Array([1, 0x42, 0xc0, 0x0a]);
		expect(buildAVCCodecString(record)).toBe("avc1.42c00a");
	});

	it("falls back when there is no record", () => {
		expect(buildAVCCodecString(undefined)).toBe("avc1.640028");
	});

	it("falls back on a truncated or wrong-version record", () => {
		expect(buildAVCCodecString(new Uint8Array([1, 0x64]))).toBe("avc1.640028");
		expect(buildAVCCodecString(new Uint8Array([9, 0x64, 0x00, 0x28]))).toBe("avc1.640028");
	});
});
