import { describe, expect, it } from "vitest";
import { isFrameBlank } from "./webcamHealth";

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
