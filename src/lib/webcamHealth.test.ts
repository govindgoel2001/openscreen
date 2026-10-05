import { describe, expect, it } from "vitest";
import { framesAreIdentical, isFrameBlank } from "./webcamHealth";

function solidFrame(value: number, pixelCount = 64): Uint8ClampedArray {
	const data = new Uint8ClampedArray(pixelCount * 4);
	for (let index = 0; index < data.length; index += 4) {
		data[index] = value;
		data[index + 1] = value;
		data[index + 2] = value;
		data[index + 3] = 255;
	}
	return data;
}

function noisyFrame(pixelCount = 64): Uint8ClampedArray {
	const data = new Uint8ClampedArray(pixelCount * 4);
	for (let index = 0; index < data.length; index += 4) {
		// Deterministic spread so the test can't flake.
		const value = (index * 7) % 256;
		data[index] = value;
		data[index + 1] = value;
		data[index + 2] = value;
		data[index + 3] = 255;
	}
	return data;
}

describe("isFrameBlank", () => {
	it("flags an all-white frame — the GoPro failure mode", () => {
		expect(isFrameBlank(solidFrame(255))).toBe(true);
	});

	it("flags an all-black frame — lens cap or dead stream", () => {
		expect(isFrameBlank(solidFrame(0))).toBe(true);
	});

	it("flags a solid mid-grey frame", () => {
		expect(isFrameBlank(solidFrame(128))).toBe(true);
	});

	it("accepts a frame with real variation", () => {
		expect(isFrameBlank(noisyFrame())).toBe(false);
	});

	it("accepts a dim frame that still carries sensor noise", () => {
		const data = solidFrame(12);
		// A poorly lit room still varies pixel to pixel.
		data[0] = 30;
		data[4] = 2;
		expect(isFrameBlank(data)).toBe(false);
	});

	it("treats an empty buffer as blank rather than throwing", () => {
		expect(isFrameBlank(new Uint8ClampedArray(0))).toBe(true);
	});

	it("tolerates trivial compression noise on a genuinely blank frame", () => {
		const data = solidFrame(255);
		data[0] = 253;
		expect(isFrameBlank(data)).toBe(true);
	});
});

describe("framesAreIdentical", () => {
	it("matches a frame against a byte-for-byte copy, which is what a still image gives", () => {
		const frame = noisyFrame();
		expect(framesAreIdentical(frame, new Uint8ClampedArray(frame))).toBe(true);
	});

	it("separates frames that differ by a single level, which is what sensor noise gives", () => {
		const frame = noisyFrame();
		const jittered = new Uint8ClampedArray(frame);
		jittered[4] = jittered[4] === 255 ? 254 : jittered[4] + 1;
		expect(framesAreIdentical(frame, jittered)).toBe(false);
	});

	it("ignores the alpha channel", () => {
		const frame = noisyFrame();
		const transparent = new Uint8ClampedArray(frame);
		for (let index = 3; index < transparent.length; index += 4) {
			transparent[index] = 0;
		}
		expect(framesAreIdentical(frame, transparent)).toBe(true);
	});

	it("treats different-sized frames as different", () => {
		expect(framesAreIdentical(noisyFrame(64), noisyFrame(32))).toBe(false);
	});

	it("does not call a solid frame identical to a different solid frame", () => {
		expect(framesAreIdentical(solidFrame(255), solidFrame(254))).toBe(false);
	});
});
