import type { CameraMarker, CameraMode, CameraRegion } from "../types";
import { DEFAULT_CAMERA_MODE } from "../types";
import { clamp01, easeOutScreenStudio } from "./mathUtils";

/**
 * How long a mode change takes. Matches the snappy feel of Screen Studio-style
 * face swaps — deliberately faster than the zoom transitions, which are a
 * slower, more ambient move.
 */
export const CAMERA_TRANSITION_MS = 320;

/**
 * Turns mode changes recorded during capture into contiguous regions.
 *
 * Each marker runs until the next one, or to the end of the recording. Markers
 * that don't change anything are dropped so the timeline stays readable.
 */
export function markersToRegions(
	markers: CameraMarker[],
	recordingDurationMs: number,
): CameraRegion[] {
	const sorted = [...markers]
		.filter((marker) => Number.isFinite(marker.timeMs) && marker.timeMs >= 0)
		.sort((a, b) => a.timeMs - b.timeMs);

	const regions: CameraRegion[] = [];
	let previousMode: CameraMode = DEFAULT_CAMERA_MODE;

	for (let index = 0; index < sorted.length; index += 1) {
		const marker = sorted[index];

		if (marker.mode === previousMode) {
			continue;
		}

		const startMs = Math.min(marker.timeMs, recordingDurationMs);
		const nextChange = sorted.slice(index + 1).find((entry) => entry.mode !== marker.mode);
		const endMs = Math.min(
			nextChange ? nextChange.timeMs : recordingDurationMs,
			recordingDurationMs,
		);

		// `normal` is the default, so a marker for it ends the previous region
		// rather than creating one of its own.
		if (marker.mode !== DEFAULT_CAMERA_MODE && endMs > startMs) {
			regions.push({
				id: `camera-${marker.mode}-${startMs}`,
				startMs,
				endMs,
				mode: marker.mode,
			});
		}

		previousMode = marker.mode;
	}

	return regions;
}

export interface ResolvedCameraMode {
	/** The mode being transitioned toward (or held). */
	mode: CameraMode;
	/** 0 = fully `normal`, 1 = fully in `mode`. */
	strength: number;
}

/**
 * Resolves the camera mode at a given time, including the eased ramp in and out.
 *
 * A region starting at 0ms opens at full strength rather than ramping — a video
 * that begins on the face should not show it inflating out of the corner.
 */
export function resolveCameraMode(regions: CameraRegion[], timeMs: number): ResolvedCameraMode {
	let best: ResolvedCameraMode = { mode: DEFAULT_CAMERA_MODE, strength: 0 };

	for (const region of regions) {
		const strength = computeRegionStrength(region, timeMs);

		if (strength > best.strength) {
			best = { mode: region.mode, strength };
		}
	}

	return best;
}

function computeRegionStrength(region: CameraRegion, timeMs: number): number {
	const fadeOutEnd = region.endMs + CAMERA_TRANSITION_MS;

	if (timeMs >= fadeOutEnd) {
		return 0;
	}

	if (timeMs > region.endMs) {
		return 1 - easeOutScreenStudio(clamp01((timeMs - region.endMs) / CAMERA_TRANSITION_MS));
	}

	// Opening region — no ramp-in, the video starts in this mode.
	if (region.startMs <= 0) {
		return timeMs >= 0 ? 1 : 0;
	}

	const fadeInStart = region.startMs - CAMERA_TRANSITION_MS;

	if (timeMs <= fadeInStart) {
		return 0;
	}

	if (timeMs < region.startMs) {
		return easeOutScreenStudio(clamp01((timeMs - fadeInStart) / CAMERA_TRANSITION_MS));
	}

	return 1;
}
