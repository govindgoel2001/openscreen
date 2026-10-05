import { describe, expect, it } from "vitest";
import { offsetToFrames, WebcamFrameFeed } from "./webcamFrameFeed";

class FakeFrame {
	closed = false;
	constructor(public readonly id: number) {}
	close() {
		this.closed = true;
	}
}

function sourceOf(count: number) {
	const frames = Array.from({ length: count }, (_, index) => new FakeFrame(index));
	let cursor = 0;
	return {
		frames,
		dequeue: async () => (cursor < frames.length ? frames[cursor++] : null),
	};
}

async function drain<T extends FakeFrame>(feed: WebcamFrameFeed<T>, count: number) {
	const ids: (number | null)[] = [];
	for (let i = 0; i < count; i++) {
		const frame = await feed.next();
		ids.push(frame ? frame.id : null);
	}
	return ids;
}

describe("offsetToFrames", () => {
	it("converts milliseconds to whole frames at the output rate", () => {
		expect(offsetToFrames(100, 60)).toBe(6);
		expect(offsetToFrames(-100, 60)).toBe(-6);
		expect(offsetToFrames(0, 60)).toBe(0);
	});

	it("returns zero for nonsense input", () => {
		expect(offsetToFrames(Number.NaN, 60)).toBe(0);
		expect(offsetToFrames(100, 0)).toBe(0);
	});
});

describe("WebcamFrameFeed", () => {
	it("passes frames straight through at zero offset", async () => {
		const source = sourceOf(4);
		const feed = new WebcamFrameFeed(source, 0);
		expect(await drain(feed, 4)).toEqual([0, 1, 2, 3]);
	});

	it("drops leading frames for a positive offset", async () => {
		const source = sourceOf(6);
		const feed = new WebcamFrameFeed(source, 2);
		expect(await drain(feed, 3)).toEqual([2, 3, 4]);
		expect(source.frames[0].closed).toBe(true);
		expect(source.frames[1].closed).toBe(true);
	});

	it("repeats the first frame for a negative offset", async () => {
		const source = sourceOf(5);
		const feed = new WebcamFrameFeed(source, -2);
		expect(await drain(feed, 5)).toEqual([0, 0, 0, 1, 2]);
	});

	it("never hands out a frame it has already closed", async () => {
		const source = sourceOf(3);
		const feed = new WebcamFrameFeed(source, -1);
		const first = await feed.next();
		const repeat = await feed.next();
		expect(repeat).toBe(first);
		expect(first?.closed).toBe(false);
		await feed.next();
		expect(first?.closed).toBe(true);
	});

	it("closes the frame it is holding when destroyed", async () => {
		const source = sourceOf(2);
		const feed = new WebcamFrameFeed(source, 0);
		const frame = await feed.next();
		feed.destroy();
		expect(frame?.closed).toBe(true);
	});

	it("returns null once the source runs dry and stays null", async () => {
		const source = sourceOf(1);
		const feed = new WebcamFrameFeed(source, 0);
		expect(await drain(feed, 3)).toEqual([0, null, null]);
	});

	it("stops skipping when the source runs dry", async () => {
		const source = sourceOf(2);
		const feed = new WebcamFrameFeed(source, 5);
		expect(await feed.next()).toBeNull();
	});

	it("stops skipping when the export is cancelled", async () => {
		const source = sourceOf(10);
		let cancelled = false;
		const feed = new WebcamFrameFeed(source, 4, () => cancelled);
		cancelled = true;
		expect((await feed.next())?.id).toBe(0);
	});
});
