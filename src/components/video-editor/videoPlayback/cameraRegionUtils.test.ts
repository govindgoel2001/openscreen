import { describe, expect, it } from "vitest";
import type { CameraMarker } from "../types";
import { CAMERA_TRANSITION_MS, markersToRegions, resolveCameraMode } from "./cameraRegionUtils";

const marker = (timeMs: number, mode: CameraMarker["mode"]): CameraMarker => ({ timeMs, mode });

describe("markersToRegions", () => {
	it("runs a region until the next mode change", () => {
		const regions = markersToRegions([marker(1000, "full"), marker(3000, "normal")], 10000);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000, mode: "full" });
	});

	it("runs the final region to the end of the recording", () => {
		const regions = markersToRegions([marker(8000, "full")], 10000);
		expect(regions[0]).toMatchObject({ startMs: 8000, endMs: 10000, mode: "full" });
	});

	it("keeps split and full as separate regions", () => {
		const regions = markersToRegions(
			[marker(1000, "full"), marker(2000, "split"), marker(3000, "normal")],
			10000,
		);
		expect(regions.map((region) => region.mode)).toEqual(["full", "split"]);
	});

	it("ignores a marker that repeats the current mode", () => {
		const regions = markersToRegions([marker(1000, "full"), marker(2000, "full")], 10000);
		expect(regions).toHaveLength(1);
		expect(regions[0].endMs).toBe(10000);
	});

	it("ignores a leading marker for the default mode", () => {
		expect(markersToRegions([marker(1000, "normal")], 10000)).toEqual([]);
	});

	it("sorts unordered markers", () => {
		const regions = markersToRegions([marker(3000, "normal"), marker(1000, "full")], 10000);
		expect(regions[0]).toMatchObject({ startMs: 1000, endMs: 3000, mode: "full" });
	});

	it("clamps a region to the recording duration", () => {
		const regions = markersToRegions([marker(1000, "full")], 5000);
		expect(regions[0].endMs).toBe(5000);
	});

	it("returns nothing when no markers were recorded", () => {
		expect(markersToRegions([], 10000)).toEqual([]);
	});
});

describe("resolveCameraMode", () => {
	const regions = markersToRegions([marker(2000, "full"), marker(5000, "normal")], 10000);

	it("reports normal at zero strength outside any region", () => {
		expect(resolveCameraMode(regions, 0)).toEqual({ mode: "normal", strength: 0 });
	});

	it("is fully in mode inside the region", () => {
		expect(resolveCameraMode(regions, 3500)).toEqual({ mode: "full", strength: 1 });
	});

	it("returns to normal well after the region", () => {
		expect(resolveCameraMode(regions, 9000).strength).toBe(0);
	});

	it("ramps up before the region starts", () => {
		const { mode, strength } = resolveCameraMode(regions, 2000 - CAMERA_TRANSITION_MS / 2);
		expect(mode).toBe("full");
		expect(strength).toBeGreaterThan(0);
		expect(strength).toBeLessThan(1);
	});

	it("ramps down after the region ends", () => {
		const strength = resolveCameraMode(regions, 5000 + CAMERA_TRANSITION_MS / 2).strength;
		expect(strength).toBeGreaterThan(0);
		expect(strength).toBeLessThan(1);
	});

	it("opens at full strength for a region starting at 0ms", () => {
		const opening = markersToRegions([marker(0, "full"), marker(4000, "normal")], 10000);
		expect(resolveCameraMode(opening, 0)).toEqual({ mode: "full", strength: 1 });
	});

	it("resolves split mode independently of full", () => {
		const split = markersToRegions([marker(1000, "split"), marker(4000, "normal")], 10000);
		expect(resolveCameraMode(split, 2000)).toEqual({ mode: "split", strength: 1 });
	});

	it("never leaves the 0..1 range across the whole timeline", () => {
		for (let t = 0; t <= 10000; t += 50) {
			const { strength } = resolveCameraMode(regions, t);
			expect(strength).toBeGreaterThanOrEqual(0);
			expect(strength).toBeLessThanOrEqual(1);
		}
	});
});
