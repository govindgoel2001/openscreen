/**
 * Virtual cameras — notably the GoPro Webcam utility, which exposes a DirectShow
 * device rather than a real UVC one — sometimes hand back a stream that opens
 * fine and reports the right resolution but only ever produces blank frames.
 * It's a race: if we open the device before the utility has frames flowing, the
 * stream never recovers on its own.
 *
 * These helpers detect that state so the recorder can re-acquire the device
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

export interface WebcamHealthResult {
	usable: boolean;
	/** Why it failed, for logging. Undefined when usable. */
	reason?: "no-video-track" | "no-frames" | "blank-frames";
	width?: number;
	height?: number;
}

/**
 * Plays the stream into an offscreen video element and samples a few frames.
 * Resolves as soon as one frame carries real image data.
 */
export async function checkWebcamStreamHealth(
	stream: MediaStream,
	options: { timeoutMs?: number; samples?: number } = {},
): Promise<WebcamHealthResult> {
	const { timeoutMs = 2500, samples = 8 } = options;
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

		for (let attempt = 0; attempt < samples && Date.now() < deadline; attempt += 1) {
			context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
			const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

			if (!isFrameBlank(data)) {
				return { usable: true, width: settings.width, height: settings.height };
			}

			await delay(120);
		}

		return {
			usable: false,
			reason: "blank-frames",
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
