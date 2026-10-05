import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	dialog,
	globalShortcut,
	ipcMain,
	screen,
	shell,
	systemPreferences,
} from "electron";
import {
	type FinalizeLiveSessionInput,
	normalizeProjectMedia,
	normalizeRecordingSession,
	type ProjectMedia,
	type RecordingSession,
	type StoreRecordedSessionInput,
} from "../../src/lib/recordingSession";
import { mainT } from "../i18n";
import { RECORDINGS_DIR } from "../main";

const PROJECT_FILE_EXTENSION = "openscreen";
const SHORTCUTS_FILE = path.join(app.getPath("userData"), "shortcuts.json");
const RECORDING_SESSION_SUFFIX = ".session.json";
const ALLOWED_IMPORT_VIDEO_EXTENSIONS = new Set([".webm", ".mp4", ".mov", ".avi", ".mkv"]);

/**
 * Paths explicitly approved by the user via file picker dialogs or project loads.
 * These are added at runtime when the user selects files from outside the default directories.
 */
const approvedPaths = new Set<string>();

function approveFilePath(filePath: string): void {
	approvedPaths.add(path.resolve(filePath));
}

function getAllowedReadDirs(): string[] {
	return [RECORDINGS_DIR];
}

function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function isPathAllowed(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	if (approvedPaths.has(resolved)) return true;
	return getAllowedReadDirs().some((dir) => isPathWithinDir(resolved, dir));
}

function hasAllowedImportVideoExtension(filePath: string): boolean {
	return ALLOWED_IMPORT_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function approveReadableVideoPath(
	filePath?: string | null,
	trustedDirs?: string[],
): Promise<string | null> {
	const normalizedPath = normalizeVideoSourcePath(filePath);
	if (!normalizedPath) {
		return null;
	}

	if (isPathAllowed(normalizedPath)) {
		return normalizedPath;
	}

	if (!hasAllowedImportVideoExtension(normalizedPath)) {
		return null;
	}

	// When called with trustedDirs (e.g. from project load), only auto-approve
	// paths within those directories. This prevents malicious project files from
	// approving reads to arbitrary filesystem locations.
	if (trustedDirs) {
		const resolved = path.resolve(normalizedPath);
		const withinTrusted = trustedDirs.some((dir) => isPathWithinDir(resolved, dir));
		if (!withinTrusted) {
			return null;
		}
	}

	try {
		const stats = await fs.stat(normalizedPath);
		if (!stats.isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	approveFilePath(normalizedPath);
	return normalizedPath;
}

function resolveRecordingOutputPath(fileName: string): string {
	const trimmed = fileName.trim();
	if (!trimmed) {
		throw new Error("Invalid recording file name");
	}

	const parsedPath = path.parse(trimmed);
	const hasTraversalSegments = trimmed.split(/[\\/]+/).some((segment) => segment === "..");
	const isNestedPath =
		parsedPath.dir !== "" ||
		path.isAbsolute(trimmed) ||
		trimmed.includes("/") ||
		trimmed.includes("\\");
	if (hasTraversalSegments || isNestedPath || parsedPath.base !== trimmed) {
		throw new Error("Recording file name must not contain path segments");
	}

	return path.join(RECORDINGS_DIR, parsedPath.base);
}

async function getApprovedProjectSession(
	project: unknown,
	projectFilePath?: string,
): Promise<RecordingSession | null> {
	if (!project || typeof project !== "object") {
		return null;
	}

	const rawProject = project as { media?: unknown; videoPath?: unknown };
	const media: ProjectMedia | null =
		normalizeProjectMedia(rawProject.media) ??
		(typeof rawProject.videoPath === "string"
			? {
					screenVideoPath: normalizeVideoSourcePath(rawProject.videoPath) ?? rawProject.videoPath,
				}
			: null);

	if (!media) {
		return null;
	}

	// Only auto-approve media paths within the project's directory or RECORDINGS_DIR.
	// This prevents crafted project files from approving reads to arbitrary locations.
	const trustedDirs = [RECORDINGS_DIR];
	if (projectFilePath) {
		trustedDirs.push(path.dirname(path.resolve(projectFilePath)));
	}

	const screenVideoPath = await approveReadableVideoPath(media.screenVideoPath, trustedDirs);
	if (!screenVideoPath) {
		throw new Error("Project references an invalid or unsupported screen video path");
	}

	const webcamVideoPath = media.webcamVideoPath
		? await approveReadableVideoPath(media.webcamVideoPath, trustedDirs)
		: undefined;
	if (media.webcamVideoPath && !webcamVideoPath) {
		throw new Error("Project references an invalid or unsupported webcam video path");
	}

	return webcamVideoPath
		? { screenVideoPath, webcamVideoPath, createdAt: Date.now() }
		: { screenVideoPath, createdAt: Date.now() };
}

type SelectedSource = {
	name: string;
	[key: string]: unknown;
};

let selectedSource: SelectedSource | null = null;
interface EditorSessionState {
	currentProjectPath: string | null;
	currentRecordingSession: RecordingSession | null;
}

const pendingEditorSession: EditorSessionState = {
	currentProjectPath: null,
	currentRecordingSession: null,
};
const editorSessions = new WeakMap<Electron.WebContents, EditorSessionState>();

export function bindEditorSession(contents: Electron.WebContents) {
	editorSessions.set(contents, { ...pendingEditorSession });
}

function getEditorSession(contents: Electron.WebContents): EditorSessionState {
	return editorSessions.get(contents) ?? pendingEditorSession;
}

function normalizePath(filePath: string) {
	return path.resolve(filePath);
}

function normalizeVideoSourcePath(videoPath?: string | null): string | null {
	if (typeof videoPath !== "string") {
		return null;
	}

	const trimmed = videoPath.trim();
	if (!trimmed) {
		return null;
	}

	if (/^file:\/\//i.test(trimmed)) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			// Fall through and keep best-effort string path below.
		}
	}

	return trimmed;
}

function isTrustedProjectPath(filePath: string | null | undefined, state: EditorSessionState) {
	if (!filePath || !state.currentProjectPath) {
		return false;
	}
	return normalizePath(filePath) === normalizePath(state.currentProjectPath);
}

function setCurrentRecordingSessionState(
	session: RecordingSession | null,
	state: EditorSessionState = pendingEditorSession,
) {
	state.currentRecordingSession = session;
}

function getSessionManifestPathForVideo(videoPath: string) {
	const parsed = path.parse(videoPath);
	const baseName = parsed.name.endsWith("-webcam")
		? parsed.name.slice(0, -"-webcam".length)
		: parsed.name;
	return path.join(parsed.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

async function loadRecordedSessionForVideoPath(
	videoPath: string,
): Promise<RecordingSession | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	try {
		const manifestPath = getSessionManifestPathForVideo(normalizedVideoPath);
		const content = await fs.readFile(manifestPath, "utf-8");
		const session = normalizeRecordingSession(JSON.parse(content));
		if (!session) {
			return null;
		}

		const normalizedSession: RecordingSession = {
			...session,
			screenVideoPath: normalizeVideoSourcePath(session.screenVideoPath) ?? session.screenVideoPath,
			...(session.webcamVideoPath
				? {
						webcamVideoPath:
							normalizeVideoSourcePath(session.webcamVideoPath) ?? session.webcamVideoPath,
					}
				: {}),
		};

		const targetPath = normalizePath(normalizedVideoPath);
		const screenMatches = normalizePath(normalizedSession.screenVideoPath) === targetPath;
		const webcamMatches = normalizedSession.webcamVideoPath
			? normalizePath(normalizedSession.webcamVideoPath) === targetPath
			: false;

		return screenMatches || webcamMatches ? normalizedSession : null;
	} catch {
		return null;
	}
}

async function storeRecordedSessionFiles(payload: StoreRecordedSessionInput) {
	const screenVideoPath = resolveRecordingOutputPath(payload.screen.fileName);
	await fs.writeFile(screenVideoPath, Buffer.from(payload.screen.videoData));

	let webcamVideoPath: string | undefined;
	if (payload.webcam) {
		webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
		await fs.writeFile(webcamVideoPath, Buffer.from(payload.webcam.videoData));
	}

	return writeRecordedSessionSidecars(screenVideoPath, webcamVideoPath, payload);
}

// Live recordings are written to disk a chunk at a time while recording, so a
// long take never has to exist in memory. Holding a 4K take in the renderer and
// copying it into an ArrayBuffer and across IPC on stop ran the app out of
// memory on anything past ~20 minutes, and lost the whole take when it did.
type LiveRecording = { handle: FileHandle; queue: Promise<void> };
const liveRecordings = new Map<string, LiveRecording>();

async function openLiveRecording(fileName: string) {
	const filePath = resolveRecordingOutputPath(fileName);
	const existing = liveRecordings.get(filePath);
	if (existing) {
		await existing.queue.catch(() => undefined);
		await existing.handle.close().catch(() => undefined);
	}
	const handle = await fs.open(filePath, "w");
	liveRecordings.set(filePath, { handle, queue: Promise.resolve() });
}

function appendLiveRecording(fileName: string, data: ArrayBuffer) {
	const filePath = resolveRecordingOutputPath(fileName);
	const live = liveRecordings.get(filePath);
	if (!live) {
		return Promise.reject(new Error(`No live recording open for ${fileName}`));
	}
	// Chained so chunks land in the order the recorder produced them, even
	// though each IPC call is handled asynchronously.
	live.queue = live.queue.then(async () => {
		await live.handle.write(Buffer.from(data));
	});
	return live.queue;
}

async function closeLiveRecording(fileName: string) {
	const filePath = resolveRecordingOutputPath(fileName);
	const live = liveRecordings.get(filePath);
	if (!live) {
		return filePath;
	}
	liveRecordings.delete(filePath);
	await live.queue.catch(() => undefined);
	await live.handle.sync().catch(() => undefined);
	await live.handle.close();
	return filePath;
}

// MediaRecorder output has no duration and no seek index, and the editor can't
// open a file without a duration. A stream copy through ffmpeg writes both
// without touching the picture. The muxer is forced to matroska because the
// recorder often picks H.264, which ffmpeg's webm muxer refuses; Chromium plays
// matroska with H.264 under a .webm name, which is what the recorder wrote anyway.
function remuxInPlace(filePath: string) {
	const tmpPath = `${filePath}.remux.webm`;
	return new Promise<void>((resolve) => {
		const proc = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				filePath,
				"-map",
				"0",
				"-c",
				"copy",
				"-f",
				"matroska",
				tmpPath,
			],
			{ windowsHide: true },
		);
		let stderr = "";
		proc.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("error", (error) => {
			console.error("ffmpeg not available to finalize recording:", error);
			resolve();
		});
		proc.on("close", async (code) => {
			if (code !== 0) {
				console.error(`ffmpeg remux failed (${code}):`, stderr.slice(-2000));
			}
			if (code === 0) {
				await fs.rename(tmpPath, filePath).catch(() => undefined);
			}
			await fs.rm(tmpPath, { force: true }).catch(() => undefined);
			resolve();
		});
	});
}

async function finalizeLiveSession(payload: FinalizeLiveSessionInput) {
	const screenVideoPath = await closeLiveRecording(payload.screenFileName);
	const webcamVideoPath = payload.webcamFileName
		? await closeLiveRecording(payload.webcamFileName)
		: undefined;

	await remuxInPlace(screenVideoPath);
	if (webcamVideoPath) {
		await remuxInPlace(webcamVideoPath);
	}

	return writeRecordedSessionSidecars(screenVideoPath, webcamVideoPath, payload);
}

async function discardLiveRecording(fileName: string) {
	const filePath = await closeLiveRecording(fileName);
	await fs.rm(filePath, { force: true });
}

async function writeRecordedSessionSidecars(
	screenVideoPath: string,
	webcamVideoPath: string | undefined,
	payload: Pick<StoreRecordedSessionInput, "createdAt" | "cameraMarkers" | "durationMs">,
) {
	const createdAt =
		typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
			? payload.createdAt
			: Date.now();

	const session: RecordingSession = webcamVideoPath
		? { screenVideoPath, webcamVideoPath, createdAt }
		: { screenVideoPath, createdAt };
	setCurrentRecordingSessionState(session);
	pendingEditorSession.currentProjectPath = null;

	const telemetryPath = `${screenVideoPath}.cursor.json`;
	if (pendingCursorSamples.length > 0) {
		await fs.writeFile(
			telemetryPath,
			JSON.stringify({ version: CURSOR_TELEMETRY_VERSION, samples: pendingCursorSamples }, null, 2),
			"utf-8",
		);
	}
	pendingCursorSamples = [];

	const cameraMarkers = Array.isArray(payload.cameraMarkers)
		? payload.cameraMarkers.filter(
				(marker) =>
					marker &&
					typeof marker.timeMs === "number" &&
					Number.isFinite(marker.timeMs) &&
					marker.timeMs >= 0,
			)
		: [];
	if (cameraMarkers.length > 0) {
		await fs.writeFile(
			`${screenVideoPath}.camera.json`,
			JSON.stringify(
				{
					version: CAMERA_MARKERS_VERSION,
					markers: cameraMarkers,
					durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : 0,
				},
				null,
				2,
			),
			"utf-8",
		);
	}

	const sessionManifestPath = path.join(
		RECORDINGS_DIR,
		`${path.parse(screenVideoPath).name}${RECORDING_SESSION_SUFFIX}`,
	);
	await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");

	return {
		success: true,
		path: screenVideoPath,
		session,
		message: "Recording session stored successfully",
	};
}

const CURSOR_TELEMETRY_VERSION = 1;
const CURSOR_SAMPLE_INTERVAL_MS = 100;
const MAX_CURSOR_SAMPLES = 60 * 60 * 10; // 1 hour @ 10Hz

interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
}

let cursorCaptureInterval: NodeJS.Timeout | null = null;
let cursorCaptureStartTimeMs = 0;
let activeCursorSamples: CursorTelemetryPoint[] = [];
let pendingCursorSamples: CursorTelemetryPoint[] = [];

const CAMERA_MARKERS_VERSION = 2;

/**
 * One key per mode rather than a single cycling key. Absolute beats relative:
 * pressing F10 always means "split", whatever mode you were in, so you can
 * never lose track of the current state mid-recording.
 */
const CAMERA_MODE_ACCELERATORS: Record<string, "full" | "split" | "normal"> = {
	F9: "full",
	F10: "split",
	F11: "normal",
};

/**
 * Camera-swap markers are timestamped by the renderer, not here — it owns the
 * recording clock and is the only side that knows about pause. The main process
 * just owns the global hotkey and forwards the press, then persists whatever
 * timestamps the renderer hands back when the recording is stored.
 */
/** Returns the accelerators that could not be claimed, so the UI can say so. */
function registerCameraModeShortcuts(): string[] {
	const failed: string[] = [];

	for (const [accelerator, mode] of Object.entries(CAMERA_MODE_ACCELERATORS)) {
		if (globalShortcut.isRegistered(accelerator)) {
			continue;
		}

		const registered = globalShortcut.register(accelerator, () => {
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send("camera-mode-pressed", mode);
			}
		});

		if (!registered) {
			failed.push(accelerator);
		}
	}

	return failed;
}

function unregisterCameraModeShortcuts() {
	for (const accelerator of Object.keys(CAMERA_MODE_ACCELERATORS)) {
		if (globalShortcut.isRegistered(accelerator)) {
			globalShortcut.unregister(accelerator);
		}
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function stopCursorCapture() {
	if (cursorCaptureInterval) {
		clearInterval(cursorCaptureInterval);
		cursorCaptureInterval = null;
	}
}

function sampleCursorPoint() {
	const cursor = screen.getCursorScreenPoint();
	const sourceDisplayId = Number(selectedSource?.display_id);
	const sourceDisplay = Number.isFinite(sourceDisplayId)
		? (screen.getAllDisplays().find((display) => display.id === sourceDisplayId) ?? null)
		: null;
	const display = sourceDisplay ?? screen.getDisplayNearestPoint(cursor);
	const bounds = display.bounds;
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);

	const cx = clamp((cursor.x - bounds.x) / width, 0, 1);
	const cy = clamp((cursor.y - bounds.y) / height, 0, 1);

	activeCursorSamples.push({
		timeMs: Math.max(0, Date.now() - cursorCaptureStartTimeMs),
		cx,
		cy,
	});

	if (activeCursorSamples.length > MAX_CURSOR_SAMPLES) {
		activeCursorSamples.shift();
	}
}

export function registerIpcHandlers(
	createEditorWindow: () => void,
	createSourceSelectorWindow: () => BrowserWindow,
	getSourceSelectorWindow: () => BrowserWindow | null,
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
	switchToHud?: (editorWindow?: BrowserWindow | null) => void,
) {
	ipcMain.handle("switch-to-hud", (event) => {
		if (switchToHud) switchToHud(BrowserWindow.fromWebContents(event.sender));
	});
	ipcMain.handle("start-new-recording", async (event) => {
		try {
			if (switchToHud) {
				switchToHud(BrowserWindow.fromWebContents(event.sender));
			}
			return { success: true };
		} catch (error) {
			console.error("Failed to start new recording:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("get-sources", async (_, opts) => {
		const sources = await desktopCapturer.getSources(opts);
		return sources.map((source) => ({
			id: source.id,
			name: source.name,
			display_id: source.display_id,
			thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
			appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
		}));
	});

	ipcMain.handle("select-source", (_, source: SelectedSource) => {
		selectedSource = source;
		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.close();
		}
		return selectedSource;
	});

	ipcMain.handle("get-selected-source", () => {
		return selectedSource;
	});

	ipcMain.handle("request-camera-access", async () => {
		if (process.platform !== "darwin") {
			return { success: true, granted: true, status: "granted" };
		}

		try {
			const status = systemPreferences.getMediaAccessStatus("camera");
			if (status === "granted") {
				return { success: true, granted: true, status };
			}

			if (status === "not-determined") {
				const granted = await systemPreferences.askForMediaAccess("camera");
				return {
					success: true,
					granted,
					status: granted ? "granted" : systemPreferences.getMediaAccessStatus("camera"),
				};
			}

			return { success: true, granted: false, status };
		} catch (error) {
			console.error("Failed to request camera access:", error);
			return {
				success: false,
				granted: false,
				status: "unknown",
				error: String(error),
			};
		}
	});

	ipcMain.handle("open-source-selector", () => {
		const sourceSelectorWin = getSourceSelectorWindow();
		if (sourceSelectorWin) {
			sourceSelectorWin.focus();
			return;
		}
		createSourceSelectorWindow();
	});

	ipcMain.handle("switch-to-editor", () => {
		createEditorWindow();
	});

	ipcMain.handle("store-recorded-session", async (_, payload: StoreRecordedSessionInput) => {
		try {
			return await storeRecordedSessionFiles(payload);
		} catch (error) {
			console.error("Failed to store recording session:", error);
			return {
				success: false,
				message: "Failed to store recording session",
				error: String(error),
			};
		}
	});

	ipcMain.handle("open-live-recording", async (_, fileName: string) => {
		try {
			await openLiveRecording(fileName);
			return { success: true };
		} catch (error) {
			console.error("Failed to open live recording:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("append-live-recording", async (_, fileName: string, data: ArrayBuffer) => {
		try {
			await appendLiveRecording(fileName, data);
			return { success: true };
		} catch (error) {
			console.error("Failed to write live recording chunk:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("finalize-live-session", async (_, payload: FinalizeLiveSessionInput) => {
		try {
			return await finalizeLiveSession(payload);
		} catch (error) {
			console.error("Failed to finalize live recording:", error);
			return {
				success: false,
				message: "Failed to finalize live recording",
				error: String(error),
			};
		}
	});

	ipcMain.handle("discard-live-recording", async (_, fileName: string) => {
		try {
			await discardLiveRecording(fileName);
			return { success: true };
		} catch (error) {
			console.error("Failed to discard live recording:", error);
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle("store-recorded-video", async (_, videoData: ArrayBuffer, fileName: string) => {
		try {
			return await storeRecordedSessionFiles({
				screen: { videoData, fileName },
				createdAt: Date.now(),
			});
		} catch (error) {
			console.error("Failed to store recorded video:", error);
			return {
				success: false,
				message: "Failed to store recorded video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-recorded-video-path", async (event) => {
		try {
			const { currentRecordingSession } = getEditorSession(event.sender);
			if (currentRecordingSession?.screenVideoPath) {
				return { success: true, path: currentRecordingSession.screenVideoPath };
			}

			const files = await fs.readdir(RECORDINGS_DIR);
			const videoFiles = files.filter(
				(file) => file.endsWith(".webm") && !file.endsWith("-webcam.webm"),
			);

			if (videoFiles.length === 0) {
				return { success: false, message: "No recorded video found" };
			}

			const latestVideo = videoFiles.sort().reverse()[0];
			const videoPath = path.join(RECORDINGS_DIR, latestVideo);

			return { success: true, path: videoPath };
		} catch (error) {
			console.error("Failed to get video path:", error);
			return { success: false, message: "Failed to get video path", error: String(error) };
		}
	});

	ipcMain.handle("read-binary-file", async (_, inputPath: string) => {
		try {
			const normalizedPath = normalizeVideoSourcePath(inputPath);
			if (!normalizedPath) {
				return { success: false, message: "Invalid file path" };
			}

			if (!isPathAllowed(normalizedPath)) {
				console.warn(
					"[read-binary-file] Rejected path outside allowed directories:",
					normalizedPath,
				);
				return { success: false, message: "Access denied: path outside allowed directories" };
			}

			const data = await fs.readFile(normalizedPath);
			return {
				success: true,
				data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
				path: normalizedPath,
			};
		} catch (error) {
			console.error("Failed to read binary file:", error);
			return {
				success: false,
				message: "Failed to read binary file",
				error: String(error),
			};
		}
	});

	ipcMain.handle("set-recording-state", (_, recording: boolean) => {
		if (recording) {
			stopCursorCapture();
			activeCursorSamples = [];
			pendingCursorSamples = [];
			cursorCaptureStartTimeMs = Date.now();
			sampleCursorPoint();
			cursorCaptureInterval = setInterval(sampleCursorPoint, CURSOR_SAMPLE_INTERVAL_MS);

			const unavailable = registerCameraModeShortcuts();
			if (unavailable.length > 0) {
				console.warn(
					`Could not register ${unavailable.join(", ")} — another app likely owns them. Camera modes can still be set in the editor.`,
				);
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("camera-mode-unavailable", unavailable.join(", "));
				}
			}
		} else {
			stopCursorCapture();
			pendingCursorSamples = [...activeCursorSamples];
			activeCursorSamples = [];
			unregisterCameraModeShortcuts();
		}

		const source = selectedSource || { name: "Screen" };
		if (onRecordingStateChange) {
			onRecordingStateChange(recording, source.name);
		}
	});

	ipcMain.handle("get-camera-markers", async (event, videoPath?: string) => {
		const empty = {
			success: true,
			markers: [] as Array<{ timeMs: number; mode: string }>,
			durationMs: 0,
		};
		const targetVideoPath = normalizeVideoSourcePath(
			videoPath ?? getEditorSession(event.sender).currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return empty;
		}

		if (!isPathAllowed(targetVideoPath)) {
			console.warn(
				"[get-camera-markers] Rejected path outside allowed directories:",
				targetVideoPath,
			);
			return empty;
		}

		try {
			const content = await fs.readFile(`${targetVideoPath}.camera.json`, "utf-8");
			const parsed = JSON.parse(content);
			const rawMarkers = Array.isArray(parsed?.markers) ? parsed.markers : [];

			const validModes = new Set(["normal", "split", "full"]);

			return {
				success: true,
				markers: rawMarkers
					// v1 sidecars stored bare timestamps that alternated on/off. Read
					// them as alternating full/normal so older recordings still open.
					.map((entry: unknown, index: number) =>
						typeof entry === "number"
							? { timeMs: entry, mode: index % 2 === 0 ? "full" : "normal" }
							: entry,
					)
					.filter(
						(marker: unknown): marker is { timeMs: number; mode: string } =>
							Boolean(marker) &&
							typeof (marker as { timeMs?: unknown }).timeMs === "number" &&
							Number.isFinite((marker as { timeMs: number }).timeMs) &&
							validModes.has(String((marker as { mode?: unknown }).mode)),
					)
					.map((marker: { timeMs: number; mode: string }) => ({
						timeMs: Math.max(0, marker.timeMs),
						mode: marker.mode,
					}))
					.sort((a: { timeMs: number }, b: { timeMs: number }) => a.timeMs - b.timeMs),
				durationMs:
					typeof parsed?.durationMs === "number" && Number.isFinite(parsed.durationMs)
						? Math.max(0, parsed.durationMs)
						: 0,
			};
		} catch (error) {
			// No sidecar means the recording predates this feature, or F9 was never pressed.
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				console.error("Failed to load camera markers:", error);
			}
			return empty;
		}
	});

	ipcMain.handle("get-cursor-telemetry", async (event, videoPath?: string) => {
		const targetVideoPath = normalizeVideoSourcePath(
			videoPath ?? getEditorSession(event.sender).currentRecordingSession?.screenVideoPath,
		);
		if (!targetVideoPath) {
			return { success: true, samples: [] };
		}

		if (!isPathAllowed(targetVideoPath)) {
			console.warn(
				"[get-cursor-telemetry] Rejected path outside allowed directories:",
				targetVideoPath,
			);
			return { success: true, samples: [] };
		}

		const telemetryPath = `${targetVideoPath}.cursor.json`;
		try {
			const content = await fs.readFile(telemetryPath, "utf-8");
			const parsed = JSON.parse(content);
			const rawSamples = Array.isArray(parsed)
				? parsed
				: Array.isArray(parsed?.samples)
					? parsed.samples
					: [];

			const samples: CursorTelemetryPoint[] = rawSamples
				.filter((sample: unknown) => Boolean(sample && typeof sample === "object"))
				.map((sample: unknown) => {
					const point = sample as Partial<CursorTelemetryPoint>;
					return {
						timeMs:
							typeof point.timeMs === "number" && Number.isFinite(point.timeMs)
								? Math.max(0, point.timeMs)
								: 0,
						cx:
							typeof point.cx === "number" && Number.isFinite(point.cx)
								? clamp(point.cx, 0, 1)
								: 0.5,
						cy:
							typeof point.cy === "number" && Number.isFinite(point.cy)
								? clamp(point.cy, 0, 1)
								: 0.5,
					};
				})
				.sort((a: CursorTelemetryPoint, b: CursorTelemetryPoint) => a.timeMs - b.timeMs);

			return { success: true, samples };
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") {
				return { success: true, samples: [] };
			}
			console.error("Failed to load cursor telemetry:", error);
			return {
				success: false,
				message: "Failed to load cursor telemetry",
				error: String(error),
				samples: [],
			};
		}
	});

	ipcMain.handle("open-external-url", async (_, url: string) => {
		try {
			await shell.openExternal(url);
			return { success: true };
		} catch (error) {
			console.error("Failed to open URL:", error);
			return { success: false, error: String(error) };
		}
	});

	// Return base path for assets so renderer can resolve file:// paths in production
	ipcMain.handle("get-asset-base-path", () => {
		try {
			if (app.isPackaged) {
				const assetPath = path.join(process.resourcesPath, "assets");
				return pathToFileURL(`${assetPath}${path.sep}`).toString();
			}
			const assetPath = path.join(app.getAppPath(), "public", "assets");
			return pathToFileURL(`${assetPath}${path.sep}`).toString();
		} catch (err) {
			console.error("Failed to resolve asset base path:", err);
			return null;
		}
	});

	ipcMain.handle("save-exported-video", async (_, videoData: ArrayBuffer, fileName: string) => {
		try {
			// Determine file type from extension
			const isGif = fileName.toLowerCase().endsWith(".gif");
			const filters = isGif
				? [{ name: mainT("dialogs", "fileDialogs.gifImage"), extensions: ["gif"] }]
				: [{ name: mainT("dialogs", "fileDialogs.mp4Video"), extensions: ["mp4"] }];

			const result = await dialog.showSaveDialog({
				title: isGif
					? mainT("dialogs", "fileDialogs.saveGif")
					: mainT("dialogs", "fileDialogs.saveVideo"),
				defaultPath: path.join(app.getPath("downloads"), fileName),
				filters,
				properties: ["createDirectory", "showOverwriteConfirmation"],
			});

			if (result.canceled || !result.filePath) {
				return {
					success: false,
					canceled: true,
					message: "Export canceled",
				};
			}

			await fs.writeFile(result.filePath, Buffer.from(videoData));

			return {
				success: true,
				path: result.filePath,
				message: "Video exported successfully",
			};
		} catch (error) {
			console.error("Failed to save exported video:", error);
			return {
				success: false,
				message: "Failed to save exported video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("open-video-file-picker", async (event) => {
		try {
			const result = await dialog.showOpenDialog({
				title: mainT("dialogs", "fileDialogs.selectVideo"),
				defaultPath: RECORDINGS_DIR,
				filters: [
					{
						name: mainT("dialogs", "fileDialogs.videoFiles"),
						extensions: ["webm", "mp4", "mov", "avi", "mkv"],
					},
					{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
				],
				properties: ["openFile"],
			});

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}

			const approvedPath = await approveReadableVideoPath(result.filePaths[0]);
			if (!approvedPath) {
				return {
					success: false,
					message: "Selected file is not a supported video",
				};
			}
			getEditorSession(event.sender).currentProjectPath = null;
			return {
				success: true,
				path: approvedPath,
			};
		} catch (error) {
			console.error("Failed to open file picker:", error);
			return {
				success: false,
				message: "Failed to open file picker",
				error: String(error),
			};
		}
	});

	ipcMain.handle("reveal-in-folder", async (_, filePath: string) => {
		try {
			// shell.showItemInFolder doesn't return a value, it throws on error
			shell.showItemInFolder(filePath);
			return { success: true };
		} catch (error) {
			console.error(`Error revealing item in folder: ${filePath}`, error);
			// Fallback to open the directory if revealing the item fails
			// This might happen if the file was moved or deleted after export,
			// or if the path is somehow invalid for showItemInFolder
			try {
				const openPathResult = await shell.openPath(path.dirname(filePath));
				if (openPathResult) {
					// openPath returned an error message
					return { success: false, error: openPathResult };
				}
				return { success: true, message: "Could not reveal item, but opened directory." };
			} catch (openError) {
				console.error(`Error opening directory: ${path.dirname(filePath)}`, openError);
				return { success: false, error: String(error) };
			}
		}
	});

	ipcMain.handle(
		"save-project-file",
		async (event, projectData: unknown, suggestedName?: string, existingProjectPath?: string) => {
			try {
				const state = getEditorSession(event.sender);
				const trustedExistingProjectPath = isTrustedProjectPath(existingProjectPath, state)
					? existingProjectPath
					: null;

				if (trustedExistingProjectPath) {
					await fs.writeFile(
						trustedExistingProjectPath,
						JSON.stringify(projectData, null, 2),
						"utf-8",
					);
					state.currentProjectPath = trustedExistingProjectPath;
					return {
						success: true,
						path: trustedExistingProjectPath,
						message: "Project saved successfully",
					};
				}

				const safeName = (suggestedName || `project-${Date.now()}`).replace(/[^a-zA-Z0-9-_]/g, "_");
				const defaultName = safeName.endsWith(`.${PROJECT_FILE_EXTENSION}`)
					? safeName
					: `${safeName}.${PROJECT_FILE_EXTENSION}`;

				const result = await dialog.showSaveDialog({
					title: mainT("dialogs", "fileDialogs.saveProject"),
					defaultPath: path.join(RECORDINGS_DIR, defaultName),
					filters: [
						{
							name: mainT("dialogs", "fileDialogs.openscreenProject"),
							extensions: [PROJECT_FILE_EXTENSION],
						},
						{ name: "JSON", extensions: ["json"] },
					],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				});

				if (result.canceled || !result.filePath) {
					return {
						success: false,
						canceled: true,
						message: "Save project canceled",
					};
				}

				await fs.writeFile(result.filePath, JSON.stringify(projectData, null, 2), "utf-8");
				state.currentProjectPath = result.filePath;

				return {
					success: true,
					path: result.filePath,
					message: "Project saved successfully",
				};
			} catch (error) {
				console.error("Failed to save project file:", error);
				return {
					success: false,
					message: "Failed to save project file",
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("load-project-file", async (event) => {
		try {
			const result = await dialog.showOpenDialog({
				title: mainT("dialogs", "fileDialogs.openProject"),
				defaultPath: RECORDINGS_DIR,
				filters: [
					{
						name: mainT("dialogs", "fileDialogs.openscreenProject"),
						extensions: [PROJECT_FILE_EXTENSION],
					},
					{ name: "JSON", extensions: ["json"] },
					{ name: mainT("dialogs", "fileDialogs.allFiles"), extensions: ["*"] },
				],
				properties: ["openFile"],
			});

			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true, message: "Open project canceled" };
			}

			const filePath = result.filePaths[0];
			const content = await fs.readFile(filePath, "utf-8");
			const project = JSON.parse(content);
			const session = await getApprovedProjectSession(project, filePath);
			const state = getEditorSession(event.sender);
			state.currentProjectPath = filePath;
			setCurrentRecordingSessionState(session, state);

			return {
				success: true,
				path: filePath,
				project,
			};
		} catch (error) {
			console.error("Failed to load project file:", error);
			return {
				success: false,
				message: "Failed to load project file",
				error: String(error),
			};
		}
	});

	ipcMain.handle("load-current-project-file", async (event) => {
		try {
			const state = getEditorSession(event.sender);
			const { currentProjectPath } = state;
			if (!currentProjectPath) {
				return { success: false, message: "No active project" };
			}

			const content = await fs.readFile(currentProjectPath, "utf-8");
			const project = JSON.parse(content);
			const session = await getApprovedProjectSession(project, currentProjectPath);
			setCurrentRecordingSessionState(session, state);
			return {
				success: true,
				path: currentProjectPath,
				project,
			};
		} catch (error) {
			console.error("Failed to load current project file:", error);
			return {
				success: false,
				message: "Failed to load current project file",
				error: String(error),
			};
		}
	});
	ipcMain.handle("set-current-recording-session", (event, session: RecordingSession | null) => {
		const state = getEditorSession(event.sender);
		const normalized = normalizeRecordingSession(session);
		setCurrentRecordingSessionState(normalized, state);
		state.currentProjectPath = null;
		return { success: true, session: normalized ?? undefined };
	});

	ipcMain.handle("get-current-recording-session", (event) => {
		const { currentRecordingSession } = getEditorSession(event.sender);
		return currentRecordingSession
			? { success: true, session: currentRecordingSession }
			: { success: false };
	});

	ipcMain.handle("set-current-video-path", async (event, path: string) => {
		const state = getEditorSession(event.sender);
		const normalizedPath = normalizeVideoSourcePath(path);
		if (!normalizedPath || !isPathAllowed(normalizedPath)) {
			return { success: false, message: "Video path has not been approved" };
		}

		const restoredSession = await loadRecordedSessionForVideoPath(normalizedPath);
		if (restoredSession) {
			// Approve all media paths from the restored session so they can be read later
			approveFilePath(restoredSession.screenVideoPath);
			if (restoredSession.webcamVideoPath) {
				approveFilePath(restoredSession.webcamVideoPath);
			}
			setCurrentRecordingSessionState(restoredSession, state);
		} else {
			setCurrentRecordingSessionState(
				{ screenVideoPath: normalizedPath, createdAt: Date.now() },
				state,
			);
		}
		state.currentProjectPath = null;
		return { success: true };
	});

	ipcMain.handle("get-current-video-path", (event) => {
		const { currentRecordingSession } = getEditorSession(event.sender);
		return currentRecordingSession?.screenVideoPath
			? { success: true, path: currentRecordingSession.screenVideoPath }
			: { success: false };
	});

	ipcMain.handle("clear-current-video-path", (event) => {
		setCurrentRecordingSessionState(null, getEditorSession(event.sender));
		return { success: true };
	});

	ipcMain.handle("get-platform", () => {
		return process.platform;
	});

	ipcMain.handle("get-shortcuts", async () => {
		try {
			const data = await fs.readFile(SHORTCUTS_FILE, "utf-8");
			return JSON.parse(data);
		} catch {
			return null;
		}
	});

	ipcMain.handle("save-shortcuts", async (_, shortcuts: unknown) => {
		try {
			await fs.writeFile(SHORTCUTS_FILE, JSON.stringify(shortcuts, null, 2), "utf-8");
			return { success: true };
		} catch (error) {
			console.error("Failed to save shortcuts:", error);
			return { success: false, error: String(error) };
		}
	});
}
