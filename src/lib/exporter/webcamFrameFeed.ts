/**
 * Pairs webcam frames with screen frames during export, applying the sync offset.
 *
 * The webcam is recorded to its own file by its own MediaRecorder, so the two
 * timelines only line up by luck. A positive offset means the webcam file runs
 * behind the screen recording and needs its leading frames discarded. A negative
 * offset means it runs ahead, so its first frame is held for a few output frames
 * to push it back.
 *
 * The feed owns every frame it hands out. Callers must not close them.
 */

export interface ClosableFrame {
	close(): void;
}

export interface FrameSource<TFrame> {
	dequeue(): Promise<TFrame | null>;
}

export function offsetToFrames(offsetMs: number, frameRate: number): number {
	if (!Number.isFinite(offsetMs) || !Number.isFinite(frameRate) || frameRate <= 0) {
		return 0;
	}
	return Math.round((offsetMs / 1000) * frameRate);
}

export class WebcamFrameFeed<TFrame extends ClosableFrame> {
	private current: TFrame | null = null;
	private skipRemaining: number;
	private holdRemaining: number;
	private exhausted = false;

	/**
	 * @param offsetFrames Positive drops leading webcam frames, negative repeats
	 *   the first frame that many times.
	 * @param isCancelled Checked while skipping so a cancelled export doesn't
	 *   sit draining a queue nobody is filling.
	 */
	constructor(
		private readonly source: FrameSource<TFrame>,
		offsetFrames: number,
		private readonly isCancelled: () => boolean = () => false,
	) {
		this.skipRemaining = offsetFrames > 0 ? offsetFrames : 0;
		this.holdRemaining = offsetFrames < 0 ? -offsetFrames : 0;
	}

	async next(): Promise<TFrame | null> {
		while (this.skipRemaining > 0 && !this.isCancelled()) {
			const stale = await this.source.dequeue();
			this.skipRemaining -= 1;
			if (!stale) {
				this.skipRemaining = 0;
				this.exhausted = true;
				return null;
			}
			stale.close();
		}

		if (this.exhausted) {
			return null;
		}

		if (this.current && this.holdRemaining > 0) {
			this.holdRemaining -= 1;
			return this.current;
		}

		const nextFrame = await this.source.dequeue();
		if (this.current) {
			this.current.close();
			this.current = null;
		}
		if (!nextFrame) {
			this.exhausted = true;
			return null;
		}
		this.current = nextFrame;
		return nextFrame;
	}

	destroy(): void {
		if (this.current) {
			this.current.close();
			this.current = null;
		}
	}
}
