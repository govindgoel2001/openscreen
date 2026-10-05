import type { ExportFormat, ExportQuality } from "@/lib/exporter";
import type { AspectRatio } from "@/utils/aspectRatioUtils";

const PREFS_KEY = "openscreen_user_preferences";

const VALID_ASPECT_RATIOS: readonly string[] = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"4:5",
	"16:10",
	"10:16",
	"native",
];

export interface WebcamResolution {
	/** Track label the resolution belongs to, so it is not shown for another camera. */
	label: string;
	width: number;
	height: number;
}

export interface UserPreferences {
	/** Default padding % */
	padding: number;
	/** Default aspect ratio */
	aspectRatio: AspectRatio;
	/** Default export quality */
	exportQuality: ExportQuality;
	/** Default export format */
	exportFormat: ExportFormat;
	/**
	 * Milliseconds the webcam lags the screen recording, keyed by camera.
	 * The delay belongs to the camera and its driver, not to any one recording:
	 * a virtual camera can sit half a second behind a built-in one on the same
	 * machine, so one number for every device is wrong for all but one of them.
	 */
	webcamOffsetsByDevice: Record<string, number>;
	/**
	 * The offset last set by hand. Serves two purposes: it is what a build that
	 * predates the per-camera map wrote, and it is the starting point when the
	 * camera cannot be identified.
	 */
	webcamOffsetMs: number;
	/**
	 * Camera chosen for the last recording. Without this the picker silently
	 * falls back to whatever device the OS enumerates first, which is how a
	 * take ends up on the wrong camera at the wrong resolution.
	 */
	webcamDeviceId: string | null;
	/**
	 * Label of that camera. Device IDs can rotate when a USB camera is
	 * reconnected, so the label is the fallback way to find it again.
	 */
	webcamDeviceLabel: string | null;
	/**
	 * Resolution that camera actually handed over last time it recorded, so the
	 * picker can show what you are really going to get before you hit record.
	 */
	webcamLastResolution: WebcamResolution | null;
}

const DEFAULT_PREFS: UserPreferences = {
	padding: 50,
	aspectRatio: "16:9",
	exportQuality: "good",
	exportFormat: "mp4",
	webcamOffsetsByDevice: {},
	webcamOffsetMs: 0,
	webcamDeviceId: null,
	webcamDeviceLabel: null,
	webcamLastResolution: null,
};

/** Matches the bounds of the offset slider in the editor. */
export const MAX_WEBCAM_OFFSET_MS = 1000;

function isOffsetInRange(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= -MAX_WEBCAM_OFFSET_MS &&
		value <= MAX_WEBCAM_OFFSET_MS
	);
}

/** Keeps only the entries that are a usable device id and a usable offset. */
function readWebcamOffsets(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};

	const offsets: Record<string, number> = {};
	for (const [deviceId, offset] of Object.entries(value as Record<string, unknown>)) {
		if (!deviceId.trim()) continue;
		if (isOffsetInRange(offset)) offsets[deviceId] = offset;
	}
	return offsets;
}

function readNullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function readWebcamResolution(value: unknown): WebcamResolution | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<WebcamResolution>;
	const label = readNullableString(raw.label);
	const isPositive = (n: unknown): n is number =>
		typeof n === "number" && Number.isFinite(n) && n > 0;
	if (!label || !isPositive(raw.width) || !isPositive(raw.height)) return null;
	return { label, width: raw.width, height: raw.height };
}

function safeJsonParse(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Load persisted user preferences from localStorage.
 * Returns defaults for any missing or invalid fields.
 */
export function loadUserPreferences(): UserPreferences {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };

	return {
		padding:
			typeof raw.padding === "number" &&
			Number.isFinite(raw.padding) &&
			raw.padding >= 0 &&
			raw.padding <= 100
				? raw.padding
				: DEFAULT_PREFS.padding,
		aspectRatio:
			typeof raw.aspectRatio === "string" && VALID_ASPECT_RATIOS.includes(raw.aspectRatio)
				? (raw.aspectRatio as AspectRatio)
				: DEFAULT_PREFS.aspectRatio,
		exportQuality:
			raw.exportQuality === "medium" ||
			raw.exportQuality === "good" ||
			raw.exportQuality === "source"
				? (raw.exportQuality as ExportQuality)
				: DEFAULT_PREFS.exportQuality,
		exportFormat:
			raw.exportFormat === "gif" || raw.exportFormat === "mp4"
				? (raw.exportFormat as ExportFormat)
				: DEFAULT_PREFS.exportFormat,
		webcamOffsetsByDevice: readWebcamOffsets(raw.webcamOffsetsByDevice),
		webcamOffsetMs: isOffsetInRange(raw.webcamOffsetMs)
			? raw.webcamOffsetMs
			: DEFAULT_PREFS.webcamOffsetMs,
		webcamDeviceId: readNullableString(raw.webcamDeviceId),
		webcamDeviceLabel: readNullableString(raw.webcamDeviceLabel),
		webcamLastResolution: readWebcamResolution(raw.webcamLastResolution),
	};
}

/**
 * Persist user preferences to localStorage.
 * Only the explicitly provided fields are updated.
 */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
	const current = loadUserPreferences();
	const merged = { ...current, ...partial };
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
	} catch {
		// localStorage may be unavailable (e.g. private browsing quota exceeded)
	}
}

/**
 * The offset to use for one camera.
 *
 * A camera with no stored offset starts at zero rather than inheriting the last
 * camera's delay, which would be wrong in the common case of switching between
 * a built-in camera and a slow virtual one. The exception is a profile written
 * before offsets were kept per camera: there the single stored value is all
 * there is, so it stands in until the first per-camera offset is saved.
 */
export function getWebcamOffsetMs(deviceId: string | null, prefs?: UserPreferences): number {
	const resolved = prefs ?? loadUserPreferences();
	const offsets = resolved.webcamOffsetsByDevice;

	if (deviceId) {
		const stored = offsets[deviceId];
		if (typeof stored === "number") return stored;
		if (Object.keys(offsets).length > 0) return 0;
	}

	return resolved.webcamOffsetMs;
}

/**
 * Remember an offset for one camera, and as the fallback for a recording whose
 * camera cannot be identified. Silently ignores a value that is not a number so
 * a stray read can never wipe a calibration.
 */
export function saveWebcamOffsetMs(deviceId: string | null, offsetMs: number): void {
	if (!Number.isFinite(offsetMs)) return;

	const clamped = Math.max(
		-MAX_WEBCAM_OFFSET_MS,
		Math.min(MAX_WEBCAM_OFFSET_MS, Math.round(offsetMs)),
	);
	const partial: Partial<UserPreferences> = { webcamOffsetMs: clamped };

	if (deviceId) {
		partial.webcamOffsetsByDevice = {
			...loadUserPreferences().webcamOffsetsByDevice,
			[deviceId]: clamped,
		};
	}

	saveUserPreferences(partial);
}
