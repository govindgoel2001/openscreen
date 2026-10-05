import type { CameraMarker, CameraMode } from "@/components/video-editor/types";
import { DEFAULT_CAMERA_MODE } from "@/components/video-editor/types";
import { checkWebcamStreamHealth } from "@/lib/webcamHealth";

function isCameraMode(value: string): value is CameraMode {
	return value === "normal" || value === "split" || value === "full";
}

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { selectRecordingMimeType } from "@/lib/recordingCodec";
import { requestCameraAccess } from "@/lib/requestCameraAccess";
import {
	loadUserPreferences,
	saveUserPreferences,
	type WebcamResolution,
} from "@/lib/userPreferences";

const TARGET_FRAME_RATE = 60;
const MIN_FRAME_RATE = 30;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;

const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

const CODEC_ALIGNMENT = 2;

const RECORDER_TIMESLICE_MS = 1000;
const BITS_PER_MEGABIT = 1_000_000;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const VIDEO_FILE_EXTENSION = ".webm";
const WEBCAM_FILE_SUFFIX = "-webcam";

const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;

const MIC_GAIN_BOOST = 1.4;
const WEBCAM_TARGET_WIDTH = 1920;
const WEBCAM_TARGET_HEIGHT = 1080;
const WEBCAM_TARGET_FRAME_RATE = 30;

type UseScreenRecorderReturn = {
	recording: boolean;
	paused: boolean;
	elapsedSeconds: number;
	/** The camera layout currently selected during recording. */
	cameraMode: CameraMode;
	/** When set, the recording opens on the webcam instead of the screen. */
	startWithCameraFullFrame: boolean;
	setStartWithCameraFullFrame: (enabled: boolean) => void;
	toggleRecording: () => void;
	togglePaused: () => void;
	restartRecording: () => void;
	cancelRecording: () => void;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	microphoneDeviceId: string | undefined;
	setMicrophoneDeviceId: (deviceId: string | undefined) => void;
	webcamDeviceId: string | undefined;
	setWebcamDeviceId: (deviceId: string | undefined) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => Promise<boolean>;
	/** What the camera actually negotiated, once a recording has started. */
	webcamResolution: WebcamResolution | null;
};

type RecorderHandle = {
	recorder: MediaRecorder;
	fileName: string;
	/** Resolves once the recorder has stopped and every chunk is on disk: true if anything was written. */
	writtenPromise: Promise<boolean>;
};

// Every chunk goes straight to disk as the recorder produces it. Nothing is
// kept in memory, so a long take can't run the app out of it, and if the app
// dies mid-take everything up to the last second is already in the file.
function createRecorderHandle(
	stream: MediaStream,
	options: MediaRecorderOptions,
	fileName: string,
): RecorderHandle {
	const api = window.electronAPI;
	const recorder = new MediaRecorder(stream, options);
	let bytesWritten = 0;
	let writes: Promise<unknown> = api.openLiveRecording(fileName);

	const writtenPromise = new Promise<boolean>((resolve) => {
		recorder.ondataavailable = (event: BlobEvent) => {
			const chunk = event.data;
			if (!chunk || chunk.size === 0) {
				return;
			}
			writes = writes
				.then(async () => {
					const result = await api.appendLiveRecording(fileName, await chunk.arrayBuffer());
					if (result.success) {
						bytesWritten += chunk.size;
					} else {
						console.error("Failed to write recording chunk:", result.error);
					}
				})
				.catch((error) => console.error("Failed to write recording chunk:", error));
		};
		recorder.onerror = () => {
			console.error("Recording failed:", fileName);
		};
		recorder.onstop = () => {
			// The final dataavailable fires before stop, so its write is already queued.
			void writes.then(() => resolve(bytesWritten > 0));
		};
	});

	recorder.start(RECORDER_TIMESLICE_MS);
	return { recorder, fileName, writtenPromise };
}

export function useScreenRecorder(): UseScreenRecorderReturn {
	const t = useScopedT("editor");
	const [recording, setRecording] = useState(false);
	const [paused, setPaused] = useState(false);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [cameraMode, setCameraMode] = useState<CameraMode>(DEFAULT_CAMERA_MODE);
	const [startWithCameraFullFrame, setStartWithCameraFullFrame] = useState(false);
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [microphoneDeviceId, setMicrophoneDeviceId] = useState<string | undefined>(undefined);
	const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(undefined);
	const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
	const [webcamEnabled, setWebcamEnabledState] = useState(false);
	const [webcamResolution, setWebcamResolution] = useState<WebcamResolution | null>(
		() => loadUserPreferences().webcamLastResolution,
	);
	const screenRecorder = useRef<RecorderHandle | null>(null);
	const webcamRecorder = useRef<RecorderHandle | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const screenStream = useRef<MediaStream | null>(null);
	const microphoneStream = useRef<MediaStream | null>(null);
	const webcamStream = useRef<MediaStream | null>(null);
	const mixingContext = useRef<AudioContext | null>(null);
	const recordingId = useRef<number>(0);
	const accumulatedDurationMs = useRef(0);
	const segmentStartedAt = useRef<number | null>(null);
	const cameraMarkers = useRef<CameraMarker[]>([]);
	const finalizingRecordingId = useRef<number | null>(null);
	const allowAutoFinalize = useRef(false);
	const discardRecordingId = useRef<number | null>(null);
	const restarting = useRef(false);

	const getRecordingDurationMs = useCallback(() => {
		const segmentDuration =
			segmentStartedAt.current === null ? 0 : Date.now() - segmentStartedAt.current;
		return accumulatedDurationMs.current + segmentDuration;
	}, []);

	const computeBitrate = (width: number, height: number) => {
		const pixels = width * height;
		const highFrameRateBoost =
			TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD ? HIGH_FRAME_RATE_BOOST : 1;

		if (pixels >= FOUR_K_PIXELS) {
			return Math.round(BITRATE_4K * highFrameRateBoost);
		}

		if (pixels >= QHD_PIXELS) {
			return Math.round(BITRATE_QHD * highFrameRateBoost);
		}

		return Math.round(BITRATE_BASE * highFrameRateBoost);
	};

	const teardownMedia = useCallback(() => {
		if (stream.current) {
			stream.current.getTracks().forEach((track) => track.stop());
			stream.current = null;
		}
		if (screenStream.current) {
			screenStream.current.getTracks().forEach((track) => track.stop());
			screenStream.current = null;
		}
		if (microphoneStream.current) {
			microphoneStream.current.getTracks().forEach((track) => track.stop());
			microphoneStream.current = null;
		}
		if (webcamStream.current) {
			webcamStream.current.getTracks().forEach((track) => track.stop());
			webcamStream.current = null;
		}
		if (mixingContext.current) {
			mixingContext.current.close().catch(() => {
				// Ignore close errors during recorder teardown.
			});
			mixingContext.current = null;
		}
	}, []);

	const setWebcamEnabled = useCallback(
		async (enabled: boolean) => {
			if (!enabled) {
				setWebcamEnabledState(false);
				return true;
			}

			const accessResult = await requestCameraAccess();
			if (!accessResult.success) {
				toast.error(t("recording.failedCameraAccess"));
				return false;
			}

			if (!accessResult.granted) {
				toast.error(t("recording.cameraBlocked"));
				return false;
			}

			setWebcamEnabledState(true);
			return true;
		},
		[t],
	);

	const finalizeRecording = useCallback(
		(
			activeScreenRecorder: RecorderHandle,
			activeWebcamRecorder: RecorderHandle | null,
			duration: number,
			activeRecordingId: number,
		) => {
			if (finalizingRecordingId.current === activeRecordingId) {
				return;
			}
			finalizingRecordingId.current = activeRecordingId;

			if (screenRecorder.current === activeScreenRecorder) {
				screenRecorder.current = null;
			}
			if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
				webcamRecorder.current = null;
			}

			teardownMedia();
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			window.electronAPI?.setRecordingState(false);

			void (async () => {
				try {
					const api = window.electronAPI;
					const screenWritten = await activeScreenRecorder.writtenPromise;
					const webcamWritten = activeWebcamRecorder
						? await activeWebcamRecorder.writtenPromise.catch(() => false)
						: false;

					const discarded = discardRecordingId.current === activeRecordingId;
					if (discarded || !screenWritten) {
						await api.discardLiveRecording(activeScreenRecorder.fileName);
						if (activeWebcamRecorder) {
							await api.discardLiveRecording(activeWebcamRecorder.fileName);
						}
						return;
					}
					if (activeWebcamRecorder && !webcamWritten) {
						await api.discardLiveRecording(activeWebcamRecorder.fileName);
					}

					const result = await api.finalizeLiveSession({
						screenFileName: activeScreenRecorder.fileName,
						webcamFileName:
							activeWebcamRecorder && webcamWritten ? activeWebcamRecorder.fileName : undefined,
						createdAt: activeRecordingId,
						cameraMarkers: [...cameraMarkers.current],
						durationMs: duration,
					});

					if (!result.success) {
						console.error("Failed to store recording session:", result.message);
						return;
					}

					if (result.session) {
						await window.electronAPI.setCurrentRecordingSession(result.session);
					} else if (result.path) {
						await window.electronAPI.setCurrentVideoPath(result.path);
					}

					await window.electronAPI.switchToEditor();
				} catch (error) {
					console.error("Error saving recording:", error);
				} finally {
					if (finalizingRecordingId.current === activeRecordingId) {
						finalizingRecordingId.current = null;
					}
					if (discardRecordingId.current === activeRecordingId) {
						discardRecordingId.current = null;
					}
				}
			})();
		},
		[teardownMedia],
	);

	const stopRecording = useRef(() => {
		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder) {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current;
		const duration = getRecordingDurationMs();
		const activeRecordingId = recordingId.current;

		finalizeRecording(
			activeScreenRecorder,
			activeWebcamRecorder ?? null,
			duration,
			activeRecordingId,
		);

		if (
			activeScreenRecorder.recorder.state === "recording" ||
			activeScreenRecorder.recorder.state === "paused"
		) {
			try {
				activeScreenRecorder.recorder.stop();
			} catch {
				// Recorder may already be stopping.
			}
		}
		if (activeWebcamRecorder) {
			if (
				activeWebcamRecorder.recorder.state === "recording" ||
				activeWebcamRecorder.recorder.state === "paused"
			) {
				try {
					activeWebcamRecorder.recorder.stop();
				} catch {
					// Recorder may already be stopping.
				}
			}
		}
	});

	useEffect(() => {
		let cleanup: (() => void) | undefined;

		if (window.electronAPI?.onStopRecordingFromTray) {
			cleanup = window.electronAPI.onStopRecordingFromTray(() => {
				stopRecording.current();
			});
		}

		return () => {
			if (cleanup) cleanup();
			allowAutoFinalize.current = false;
			restarting.current = false;
			discardRecordingId.current = null;

			if (
				screenRecorder.current?.recorder.state === "recording" ||
				screenRecorder.current?.recorder.state === "paused"
			) {
				try {
					screenRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			if (
				webcamRecorder.current?.recorder.state === "recording" ||
				webcamRecorder.current?.recorder.state === "paused"
			) {
				try {
					webcamRecorder.current.recorder.stop();
				} catch {
					// Ignore recorder teardown errors during cleanup.
				}
			}
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		};
	}, [teardownMedia]);

	const startRecording = async () => {
		try {
			const selectedSource = await window.electronAPI.getSelectedSource();
			if (!selectedSource) {
				alert(t("recording.selectSource"));
				return;
			}

			let screenMediaStream: MediaStream;

			const videoConstraints = {
				mandatory: {
					chromeMediaSource: CHROME_MEDIA_SOURCE,
					chromeMediaSourceId: selectedSource.id,
					maxWidth: TARGET_WIDTH,
					maxHeight: TARGET_HEIGHT,
					maxFrameRate: TARGET_FRAME_RATE,
					minFrameRate: MIN_FRAME_RATE,
				},
			};

			if (systemAudioEnabled) {
				try {
					screenMediaStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							mandatory: {
								chromeMediaSource: CHROME_MEDIA_SOURCE,
								chromeMediaSourceId: selectedSource.id,
							},
						},
						video: videoConstraints,
					} as unknown as MediaStreamConstraints);
				} catch (audioErr) {
					console.warn("System audio capture failed, falling back to video-only:", audioErr);
					toast.error(t("recording.systemAudioUnavailable"));
					screenMediaStream = await navigator.mediaDevices.getUserMedia({
						audio: false,
						video: videoConstraints,
					} as unknown as MediaStreamConstraints);
				}
			} else {
				screenMediaStream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: videoConstraints,
				} as unknown as MediaStreamConstraints);
			}
			screenStream.current = screenMediaStream;

			if (microphoneEnabled) {
				try {
					microphoneStream.current = await navigator.mediaDevices.getUserMedia({
						audio: microphoneDeviceId
							? {
									deviceId: { exact: microphoneDeviceId },
									echoCancellation: true,
									noiseSuppression: true,
									autoGainControl: true,
								}
							: {
									echoCancellation: true,
									noiseSuppression: true,
									autoGainControl: true,
								},
						video: false,
					});
				} catch (audioError) {
					console.warn("Failed to get microphone access:", audioError);
					toast.error(t("recording.microphoneDenied"));
					setMicrophoneEnabled(false);
				}
			}

			if (webcamEnabled) {
				try {
					const webcamConstraints: MediaStreamConstraints = {
						audio: false,
						video: webcamDeviceId
							? {
									deviceId: { exact: webcamDeviceId },
									width: { ideal: WEBCAM_TARGET_WIDTH },
									height: { ideal: WEBCAM_TARGET_HEIGHT },
									frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
								}
							: {
									width: { ideal: WEBCAM_TARGET_WIDTH },
									height: { ideal: WEBCAM_TARGET_HEIGHT },
									frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
								},
					};

					webcamStream.current = await navigator.mediaDevices.getUserMedia(webcamConstraints);

					// Virtual cameras (GoPro Webcam et al) can open cleanly, report the
					// right resolution, and still only ever produce blank frames. Catch
					// that here rather than after a fifteen-minute take is already lost.
					let health = await checkWebcamStreamHealth(webcamStream.current);

					if (!health.usable) {
						console.warn(
							`Webcam opened but produced no usable video (${health.reason}). Reacquiring the device...`,
						);
						webcamStream.current.getTracks().forEach((track) => track.stop());
						// Give the driver a moment to settle before the second attempt —
						// the failure is a startup race, so an immediate retry tends to
						// reproduce it.
						await new Promise((resolve) => setTimeout(resolve, 600));
						webcamStream.current = await navigator.mediaDevices.getUserMedia(webcamConstraints);
						health = await checkWebcamStreamHealth(webcamStream.current);
					}

					const webcamSettings = webcamStream.current.getVideoTracks()[0]?.getSettings();
					if (webcamSettings) {
						console.log(
							`Webcam recording at ${webcamSettings.width}x${webcamSettings.height} @ ${webcamSettings.frameRate}fps ` +
								`(requested ${WEBCAM_TARGET_WIDTH}x${WEBCAM_TARGET_HEIGHT} @ ${WEBCAM_TARGET_FRAME_RATE}fps) ` +
								`— image check: ${health.usable ? "ok" : (health.reason ?? "failed")}`,
						);
					}

					const negotiatedWidth = webcamSettings?.width;
					const negotiatedHeight = webcamSettings?.height;
					if (negotiatedWidth && negotiatedHeight) {
						const negotiated: WebcamResolution = {
							label:
								webcamStream.current.getVideoTracks()[0]?.label ?? webcamSettings?.deviceId ?? "",
							width: negotiatedWidth,
							height: negotiatedHeight,
						};
						setWebcamResolution(negotiated);
						saveUserPreferences({ webcamLastResolution: negotiated });
						// A camera quietly handing back less than was asked for is the
						// difference between a 1080p take and a 720p one, and there is no
						// other point in the flow where you would notice.
						if (negotiatedHeight < WEBCAM_TARGET_HEIGHT) {
							toast.warning(
								t("recording.webcamBelowTarget", {
									width: String(negotiatedWidth),
									height: String(negotiatedHeight),
									targetWidth: String(WEBCAM_TARGET_WIDTH),
									targetHeight: String(WEBCAM_TARGET_HEIGHT),
								}),
								{ duration: 8000 },
							);
						}
					}

					if (!health.usable) {
						// Let the recording proceed — the screen capture is still good, and
						// stopping here would lose the take entirely. But say so loudly.
						toast.error(
							t(
								health.reason === "frozen-frames"
									? "recording.webcamFrozen"
									: "recording.webcamNoImage",
							),
							{ duration: 12000 },
						);
					}
				} catch (cameraError) {
					console.warn("Failed to get webcam access:", cameraError);
					if (webcamStream.current) {
						webcamStream.current.getTracks().forEach((track) => track.stop());
						webcamStream.current = null;
					}
					setWebcamEnabledState(false);
					toast.error(t("recording.cameraDenied"));
				}
			}

			stream.current = new MediaStream();
			const videoTrack = screenMediaStream.getVideoTracks()[0];
			if (!videoTrack) {
				throw new Error("Video track is not available.");
			}
			stream.current.addTrack(videoTrack);

			const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
			const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

			if (systemAudioTrack && micAudioTrack) {
				const ctx = new AudioContext();
				mixingContext.current = ctx;
				const systemSource = ctx.createMediaStreamSource(new MediaStream([systemAudioTrack]));
				const micSource = ctx.createMediaStreamSource(new MediaStream([micAudioTrack]));
				const micGain = ctx.createGain();
				micGain.gain.value = MIC_GAIN_BOOST;
				const destination = ctx.createMediaStreamDestination();
				systemSource.connect(destination);
				micSource.connect(micGain).connect(destination);
				stream.current.addTrack(destination.stream.getAudioTracks()[0]);
			} else if (systemAudioTrack) {
				stream.current.addTrack(systemAudioTrack);
			} else if (micAudioTrack) {
				stream.current.addTrack(micAudioTrack);
			}

			try {
				await videoTrack.applyConstraints({
					frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
					width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
					height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
				});
			} catch (constraintError) {
				console.warn(
					"Unable to lock 4K/60fps constraints, using best available track settings.",
					constraintError,
				);
			}

			let {
				width = DEFAULT_WIDTH,
				height = DEFAULT_HEIGHT,
				frameRate = TARGET_FRAME_RATE,
			} = videoTrack.getSettings();

			width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
			height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

			const videoBitsPerSecond = computeBitrate(width, height);
			const mimeType = selectRecordingMimeType();

			console.log(
				`Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
					videoBitsPerSecond / BITS_PER_MEGABIT,
				)} Mbps`,
			);

			const hasAudio = stream.current.getAudioTracks().length > 0;
			// The id names the files, so it has to exist before the recorders open them.
			recordingId.current = Date.now();
			const baseName = `${RECORDING_FILE_PREFIX}${recordingId.current}`;
			screenRecorder.current = createRecorderHandle(
				stream.current,
				{
					mimeType,
					videoBitsPerSecond,
					...(hasAudio
						? { audioBitsPerSecond: systemAudioTrack ? AUDIO_BITRATE_SYSTEM : AUDIO_BITRATE_VOICE }
						: {}),
				},
				`${baseName}${VIDEO_FILE_EXTENSION}`,
			);
			screenRecorder.current.recorder.addEventListener(
				"error",
				() => {
					setRecording(false);
				},
				{ once: true },
			);

			if (webcamStream.current) {
				webcamRecorder.current = createRecorderHandle(
					webcamStream.current,
					{
						mimeType,
						videoBitsPerSecond: Math.min(videoBitsPerSecond, BITRATE_BASE),
					},
					`${baseName}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`,
				);
			}

			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = Date.now();
			allowAutoFinalize.current = true;
			// Seeding a marker at 0 opens the video on the face; computeCameraStrength
			// skips the ramp-in for a region starting at 0ms so it doesn't inflate
			// out of the corner.
			cameraMarkers.current = startWithCameraFullFrame
				? [{ timeMs: 0, mode: "full" as const }]
				: [];
			setCameraMode(startWithCameraFullFrame ? "full" : DEFAULT_CAMERA_MODE);
			setRecording(true);
			setPaused(false);
			setElapsedSeconds(0);
			window.electronAPI?.setRecordingState(true);

			const activeScreenRecorder = screenRecorder.current;
			const activeWebcamRecorder = webcamRecorder.current;
			const activeRecordingId = recordingId.current;
			if (activeScreenRecorder) {
				activeScreenRecorder.recorder.addEventListener(
					"stop",
					() => {
						if (!allowAutoFinalize.current) {
							return;
						}
						finalizeRecording(
							activeScreenRecorder,
							activeWebcamRecorder ?? null,
							Math.max(0, getRecordingDurationMs()),
							activeRecordingId,
						);
					},
					{ once: true },
				);
			}
		} catch (error) {
			console.error("Failed to start recording:", error);
			const errorMsg = error instanceof Error ? error.message : "Failed to start recording";
			if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
				toast.error(t("recording.permissionDenied"));
			} else {
				toast.error(errorMsg);
			}
			setRecording(false);
			setPaused(false);
			setElapsedSeconds(0);
			accumulatedDurationMs.current = 0;
			segmentStartedAt.current = null;
			screenRecorder.current = null;
			webcamRecorder.current = null;
			teardownMedia();
		}
	};

	const togglePaused = () => {
		const activeScreenRecorder = screenRecorder.current?.recorder;
		if (!activeScreenRecorder || activeScreenRecorder.state === "inactive") {
			return;
		}

		const activeWebcamRecorder = webcamRecorder.current?.recorder;

		if (activeScreenRecorder.state === "paused") {
			try {
				activeScreenRecorder.resume();
				if (activeWebcamRecorder?.state === "paused") {
					activeWebcamRecorder.resume();
				}
				segmentStartedAt.current = Date.now();
				setPaused(false);
			} catch (error) {
				console.error("Failed to resume recording:", error);
			}
			return;
		}

		if (activeScreenRecorder.state !== "recording") {
			return;
		}

		try {
			accumulatedDurationMs.current = getRecordingDurationMs();
			segmentStartedAt.current = null;
			setElapsedSeconds(Math.floor(accumulatedDurationMs.current / 1000));
			activeScreenRecorder.pause();
			if (activeWebcamRecorder?.state === "recording") {
				activeWebcamRecorder.pause();
			}
			setPaused(true);
		} catch (error) {
			console.error("Failed to pause recording:", error);
		}
	};

	const toggleRecording = () => {
		recording ? stopRecording.current() : startRecording();
	};

	const restartRecording = async () => {
		if (restarting.current) return;

		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state === "inactive") return;

		const activeWebcamRecorder = webcamRecorder.current;
		const activeRecordingId = recordingId.current;

		restarting.current = true;
		discardRecordingId.current = activeRecordingId;
		allowAutoFinalize.current = false;

		const stopPromises = [
			new Promise<void>((resolve) => {
				activeScreenRecorder.recorder.addEventListener("stop", () => resolve(), { once: true });
			}),
		];

		if (
			activeWebcamRecorder?.recorder.state === "recording" ||
			activeWebcamRecorder?.recorder.state === "paused"
		) {
			stopPromises.push(
				new Promise<void>((resolve) => {
					activeWebcamRecorder.recorder.addEventListener("stop", () => resolve(), {
						once: true,
					});
				}),
			);
		}

		stopRecording.current();
		await Promise.all(stopPromises);

		try {
			await startRecording();
		} finally {
			restarting.current = false;
		}
	};

	useEffect(() => {
		if (!recording) {
			setElapsedSeconds(0);
			return;
		}

		setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		if (paused) {
			return;
		}

		const interval = window.setInterval(() => {
			setElapsedSeconds(Math.floor(getRecordingDurationMs() / 1000));
		}, 250);

		return () => window.clearInterval(interval);
	}, [getRecordingDurationMs, paused, recording]);

	// The mode keys are global shortcuts owned by the main process, so they fire
	// even while another app has focus. We timestamp here rather than there
	// because getRecordingDurationMs() already excludes paused time —
	// timestamping in the main process off the wall clock would drift late after
	// every pause.
	useEffect(() => {
		if (!recording) {
			return;
		}

		const removeListener = window.electronAPI?.onCameraModePressed?.((mode) => {
			if (paused || !isCameraMode(mode)) {
				return;
			}

			setCameraMode((current) => {
				// Pressing the mode you're already in is a no-op, not a marker.
				if (current === mode) {
					return current;
				}

				cameraMarkers.current.push({ timeMs: getRecordingDurationMs(), mode });
				return mode;
			});
		});

		return removeListener;
	}, [getRecordingDurationMs, paused, recording]);

	useEffect(() => {
		const removeListener = window.electronAPI?.onCameraModeUnavailable?.((accelerators) => {
			toast.error(t("recording.cameraModeUnavailable", { accelerators }));
		});

		return removeListener;
	}, [t]);

	const cancelRecording = () => {
		const activeScreenRecorder = screenRecorder.current;
		if (!activeScreenRecorder || activeScreenRecorder.recorder.state !== "recording") return;

		const activeRecordingId = recordingId.current;
		discardRecordingId.current = activeRecordingId;
		allowAutoFinalize.current = false;

		stopRecording.current();
	};

	return {
		recording,
		paused,
		elapsedSeconds,
		cameraMode,
		startWithCameraFullFrame,
		setStartWithCameraFullFrame,
		toggleRecording,
		togglePaused,
		restartRecording,
		cancelRecording,
		microphoneEnabled,
		setMicrophoneEnabled,
		microphoneDeviceId,
		setMicrophoneDeviceId,
		webcamDeviceId,
		webcamResolution,
		setWebcamDeviceId,
		systemAudioEnabled,
		setSystemAudioEnabled,
		webcamEnabled,
		setWebcamEnabled,
	};
}
