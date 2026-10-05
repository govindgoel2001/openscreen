/**
 * Virtual cameras — notably the GoPro Webcam utility, which exposes a DirectShow
 * device rather than a real UVC one — sometimes hand back a stream that opens
 * fine and reports the right resolution but only ever produces blank frames.
 * It's a race: if we open the device before the utility has frames flowing, the
 * stream never recovers on its own.
 *
 * The other failure mode is the GoPro splash screen: the utility hands over a
 * perfectly valid still image of the GoPro logo and never replaces it with live
 * video. That happens when the camera's USB Connection is set to MTP instead of
 * GoPro Connect, when a firewall blocks the GoPro USB network device, or when
 * the utility picked the wrong GPU on a hybrid-graphics laptop. A splash frame
 * is not blank, so it needs a separate check: real video never repeats a frame
 * byte for byte, a decoded still always does.
 *
 * These helpers detect both states so the recorder can re-acquire the device
 * instead of silently recording a white rectangle for fifteen minutes.
 */

/** Downsample size for the blank check — enough to spot detail, cheap to read. */
const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 18;

/**
 * A frame is "blank" when every sampled pixel is essentially the same colour.
 * A real camera frame — even a dark or badly lit one — always carries sensor
 * noise, so near-zero variance means no image, not a plain wall.
 */
export function isFrameBlank(pixels: Uint8ClampedArray, tolerance = 4): boolean {
	if (pixels.length < 4) {
		return true;
	}

	let minLuma = 255;
	let maxLuma = 0;

	for (let index = 0; index < pixels.length; index += 4) {
		// Rec. 601 luma — close enough for "is there any image here".
		const luma = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];

		if (luma < minLuma) minLuma = luma;
		if (luma > maxLuma) maxLuma = luma;

		// Spread already proves it isn't blank; stop early.
		if (maxLuma - minLuma > tolerance) {
			return false;
		}
	}

	return maxLuma - minLuma <= tolerance;
}

/**
 * True when two sampled frames are byte-identical across RGB.
 *
 * Exact equality is deliberate. Sensor noise means a live camera pointed at a
 * motionless wall still varies by a level or two per pixel, while a decoded
 * still image repeats exactly. Anything looser starts calling real footage frozen.
 */
export function framesAreIdentical(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
	if (a.length !== b.length) {
		return false;
	}

	for (let index = 0; index < a.length; index += 4) {
		if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2]) {
			return false;
		}
	}

	return true;
}

export interface WebcamHealthResult {
	usable: boolean;
	/** Why it failed, for logging. Undefined when usable. */
	reason?: "no-video-track" | "no-frames" | "blank-frames" | "frozen-frames";
	width?: number;
	height?: number;
}

/** Identical non-blank samples in a row before the stream is called frozen. */
const FROZEN_SAMPLE_RUN = 4;

/**
 * Plays the stream into an offscreen video element and samples a few frames.
 * Resolves as soon as one frame carries real image data.
 */
export async function checkWebcamStreamHealth(
	stream: MediaStream,
	options: { timeoutMs?: number; samples?: number } = {},
): Promise<WebcamHealthResult> {
	const { timeoutMs = 2500, samples = 10 } = options;
	const track = stream.getVideoTracks()[0];

	if (!track) {
		return { usable: false, reason: "no-video-track" };
	}

	const settings = track.getSettings();
	const video = document.createElement("video");
	video.srcObject = stream;
	video.muted = true;
	video.playsInline = true;

	const canvas = document.createElement("canvas");
	canvas.width = SAMPLE_WIDTH;
	canvas.height = SAMPLE_HEIGHT;
	const context = canvas.getContext("2d", { willReadFrequently: true });

	try {
		await video.play().catch(() => undefined);

		const deadline = Date.now() + timeoutMs;

		// Wait for the element to actually have decodable data.
		while (video.readyState < 2 && Date.now() < deadline) {
			await delay(100);
		}

		if (video.readyState < 2 || !context) {
			return {
				usable: false,
				reason: "no-frames",
				width: settings.width,
				height: settings.height,
			};
		}

		let previous: Uint8ClampedArray | null = null;
		let identicalRun = 0;
		let sawImage = false;

		for (let attempt = 0; attempt < samples && Date.now() < deadline; attempt += 1) {
			context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
			const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

			if (!isFrameBlank(data)) {
				sawImage = true;

				if (previous && framesAreIdentical(previous, data)) {
					identicalRun += 1;
					if (identicalRun >= FROZEN_SAMPLE_RUN) {
						return {
							usable: false,
							reason: "frozen-frames",
							width: settings.width,
							height: settings.height,
						};
					}
				} else if (previous) {
					// Two different frames with real content: the feed is live.
					return { usable: true, width: settings.width, height: settings.height };
				}

				previous = data;
			}

			await delay(120);
		}

		// Ran out of samples without ever seeing the picture change. Only enough
		// evidence to call it frozen if there was a picture in the first place.
		return {
			usable: false,
			reason: sawImage ? "frozen-frames" : "blank-frames",
			width: settings.width,
			height: settings.height,
		};
	} finally {
		video.pause();
		video.srcObject = null;
	}
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
