import { beforeEach, describe, expect, it } from "vitest";
import {
	getWebcamOffsetMs,
	loadUserPreferences,
	saveUserPreferences,
	saveWebcamOffsetMs,
} from "./userPreferences";

const PREFS_KEY = "openscreen_user_preferences";

function writeRaw(value: unknown): void {
	localStorage.setItem(PREFS_KEY, JSON.stringify(value));
}

beforeEach(() => {
	localStorage.clear();
});

describe("getWebcamOffsetMs", () => {
	it("is zero for a camera that has never been calibrated", () => {
		expect(getWebcamOffsetMs("some-camera")).toBe(0);
	});

	it("returns the value stored for that camera", () => {
		saveWebcamOffsetMs("gopro", 500);
		expect(getWebcamOffsetMs("gopro")).toBe(500);
	});

	it("keeps a separate offset per camera", () => {
		saveWebcamOffsetMs("gopro", 500);
		saveWebcamOffsetMs("builtin", 20);

		expect(getWebcamOffsetMs("gopro")).toBe(500);
		expect(getWebcamOffsetMs("builtin")).toBe(20);
	});

	it("does not leak one camera's offset onto an uncalibrated one", () => {
		saveWebcamOffsetMs("gopro", 500);
		expect(getWebcamOffsetMs("a-different-camera")).toBe(0);
	});

	it("falls back to the pre-existing global offset for an unknown camera", () => {
		// Written by a build that stored a single offset for every camera.
		writeRaw({ webcamOffsetMs: 320 });
		expect(getWebcamOffsetMs("gopro")).toBe(320);
	});

	it("prefers the per-camera offset over the legacy global one", () => {
		writeRaw({ webcamOffsetMs: 320, webcamOffsetsByDevice: { gopro: 500 } });
		expect(getWebcamOffsetMs("gopro")).toBe(500);
	});

	it("uses the last-used offset when no camera is identified", () => {
		writeRaw({ webcamOffsetMs: 320 });
		expect(getWebcamOffsetMs(null)).toBe(320);
	});

	it("survives a corrupt offset map", () => {
		writeRaw({ webcamOffsetsByDevice: { gopro: "not a number", other: 40 } });
		expect(getWebcamOffsetMs("gopro")).toBe(0);
		expect(getWebcamOffsetMs("other")).toBe(40);
	});

	it("ignores an offset stored outside the slider range", () => {
		writeRaw({ webcamOffsetsByDevice: { gopro: 99999 } });
		expect(getWebcamOffsetMs("gopro")).toBe(0);
	});
});

describe("saveWebcamOffsetMs", () => {
	it("clamps to the slider range", () => {
		saveWebcamOffsetMs("gopro", 9000);
		expect(getWebcamOffsetMs("gopro")).toBe(1000);

		saveWebcamOffsetMs("gopro", -9000);
		expect(getWebcamOffsetMs("gopro")).toBe(-1000);
	});

	it("rounds to whole milliseconds", () => {
		saveWebcamOffsetMs("gopro", 499.6);
		expect(getWebcamOffsetMs("gopro")).toBe(500);
	});

	it("ignores a value that is not a number", () => {
		saveWebcamOffsetMs("gopro", Number.NaN);
		expect(getWebcamOffsetMs("gopro")).toBe(0);
	});

	it("also records the value as the fallback for other cameras", () => {
		saveWebcamOffsetMs("gopro", 500);
		expect(loadUserPreferences().webcamOffsetMs).toBe(500);
	});

	it("still records the fallback when no camera is identified", () => {
		saveWebcamOffsetMs(null, 500);
		expect(loadUserPreferences().webcamOffsetMs).toBe(500);
		expect(loadUserPreferences().webcamOffsetsByDevice).toEqual({});
	});

	it("does not disturb other preferences", () => {
		saveUserPreferences({ padding: 42, aspectRatio: "9:16" });
		saveWebcamOffsetMs("gopro", 500);

		const prefs = loadUserPreferences();
		expect(prefs.padding).toBe(42);
		expect(prefs.aspectRatio).toBe("9:16");
	});
});

describe("loadUserPreferences", () => {
	it("returns an empty offset map when nothing is stored", () => {
		expect(loadUserPreferences().webcamOffsetsByDevice).toEqual({});
	});

	it("drops invalid entries from the offset map but keeps the good ones", () => {
		writeRaw({ webcamOffsetsByDevice: { good: 500, bad: null, alsoBad: 5000, "": 10 } });
		expect(loadUserPreferences().webcamOffsetsByDevice).toEqual({ good: 500 });
	});

	it("survives a non-object offset map", () => {
		writeRaw({ webcamOffsetsByDevice: "nope" });
		expect(loadUserPreferences().webcamOffsetsByDevice).toEqual({});
	});
});
