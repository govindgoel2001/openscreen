import { describe, expect, it } from "vitest";
import { computeCompositeLayout } from "./compositeLayout";

describe("computeCompositeLayout — camera modes", () => {
	const base = {
		canvasSize: { width: 1920, height: 1080 },
		screenSize: { width: 1920, height: 1080 },
		webcamSize: { width: 1280, height: 720 },
	};

	it("is unchanged at strength 0", () => {
		const withZero = computeCompositeLayout({ ...base, cameraMode: "full", cameraStrength: 0 });
		expect(withZero).toEqual(computeCompositeLayout(base));
	});

	it("is unchanged in normal mode regardless of strength", () => {
		const normal = computeCompositeLayout({ ...base, cameraMode: "normal", cameraStrength: 1 });
		expect(normal).toEqual(computeCompositeLayout(base));
	});

	it("fills the canvas in full mode", () => {
		const layout = computeCompositeLayout({ ...base, cameraMode: "full", cameraStrength: 1 });
		expect(layout?.webcamRect).toMatchObject({
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			borderRadius: 0,
		});
		expect(layout?.screenOpacity).toBe(0);
	});

	it("puts the webcam across the bottom in split mode", () => {
		const layout = computeCompositeLayout({ ...base, cameraMode: "split", cameraStrength: 1 });
		expect(layout?.webcamRect?.x).toBe(0);
		expect(layout?.webcamRect?.width).toBe(1920);
		// Bottom band, so it starts below the midpoint and reaches the canvas floor.
		expect(layout?.webcamRect?.y).toBeGreaterThan(540);
		expect((layout?.webcamRect?.y ?? 0) + (layout?.webcamRect?.height ?? 0)).toBe(1080);
	});

	it("keeps the screen visible in split mode", () => {
		const layout = computeCompositeLayout({ ...base, cameraMode: "split", cameraStrength: 1 });
		expect(layout?.screenOpacity ?? 1).toBe(1);
		expect(layout?.screenRect.height).toBeGreaterThan(0);
	});

	it("keeps the screen above the webcam in split mode", () => {
		const layout = computeCompositeLayout({ ...base, cameraMode: "split", cameraStrength: 1 });
		const screenBottom = layout!.screenRect.y + layout!.screenRect.height;
		expect(screenBottom).toBeLessThanOrEqual(layout!.webcamRect!.y);
	});

	it("lands partway through at half strength", () => {
		const small = computeCompositeLayout(base)?.webcamRect;
		const half = computeCompositeLayout({
			...base,
			cameraMode: "full",
			cameraStrength: 0.5,
		})?.webcamRect;
		expect(half?.width).toBeGreaterThan(small?.width ?? 0);
		expect(half?.width).toBeLessThan(1920);
	});

	it("drops a circular mask once the webcam grows", () => {
		const layout = computeCompositeLayout({
			...base,
			webcamMaskShape: "circle",
			cameraMode: "full",
			cameraStrength: 1,
		});
		expect(layout?.webcamRect?.maskShape).toBe("rectangle");
	});

	it("does nothing when there is no webcam", () => {
		const layout = computeCompositeLayout({
			...base,
			webcamSize: null,
			cameraMode: "full",
			cameraStrength: 1,
		});
		expect(layout?.webcamRect).toBeNull();
		expect(layout?.screenOpacity).toBeUndefined();
	});
});

describe("computeCompositeLayout", () => {
	it("anchors the overlay in the lower-right corner", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
		});

		expect(layout).not.toBeNull();
		expect(layout!.webcamRect).not.toBeNull();
		expect(layout!.webcamRect!.x + layout!.webcamRect!.width).toBeLessThanOrEqual(1920);
		expect(layout!.webcamRect!.y + layout!.webcamRect!.height).toBeLessThanOrEqual(1080);
		expect(layout!.webcamRect!.x).toBeGreaterThan(1920 / 2);
		expect(layout!.webcamRect!.y).toBeGreaterThan(1080 / 2);
	});

	it("keeps the overlay within the configured stage fraction while preserving aspect ratio", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1280, height: 720 },
			screenSize: { width: 1280, height: 720 },
			webcamSize: { width: 1920, height: 1080 },
		});

		expect(layout).not.toBeNull();
		expect(layout!.webcamRect).not.toBeNull();
		expect(layout!.webcamRect!.width).toBeLessThanOrEqual(Math.round(1280 * 0.26) + 1);
		expect(layout!.webcamRect!.height).toBeLessThanOrEqual(Math.round(720 * 0.26) + 1);
		expect(
			Math.abs(layout!.webcamRect!.width * 1080 - layout!.webcamRect!.height * 1920),
		).toBeLessThanOrEqual(1920);
	});

	it("uses cover-style full-width stacking in vertical stack mode", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			maxContentSize: { width: 1536, height: 864 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			layoutPreset: "vertical-stack",
		});

		expect(layout).not.toBeNull();
		expect(layout?.screenRect).toEqual({
			x: 0,
			y: 0,
			width: 1920,
			height: 0,
		});
		expect(layout?.webcamRect).toEqual({
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			borderRadius: 0,
		});
		expect(layout?.screenCover).toBe(true);
	});

	it("fills the canvas with the screen when vertical stack has no webcam", () => {
		const layout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			maxContentSize: { width: 1536, height: 864 },
			screenSize: { width: 1920, height: 1080 },
			layoutPreset: "vertical-stack",
		});

		expect(layout).not.toBeNull();
		expect(layout?.screenRect).toEqual({
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
		});
		expect(layout?.webcamRect).toBeNull();
		expect(layout?.screenCover).toBe(true);
	});

	it("forces circular and square masks to use square dimensions", () => {
		const circularLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "circle",
		});
		const squareLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "square",
		});

		expect(circularLayout?.webcamRect).not.toBeNull();
		expect(squareLayout?.webcamRect).not.toBeNull();
		expect(circularLayout?.webcamRect?.width).toBe(circularLayout?.webcamRect?.height);
		expect(squareLayout?.webcamRect?.width).toBe(squareLayout?.webcamRect?.height);
		expect(circularLayout?.webcamRect?.maskShape).toBe("circle");
		expect(squareLayout?.webcamRect?.maskShape).toBe("square");
	});

	it("applies larger rounding for the rounded webcam mask", () => {
		const roundedLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "rounded",
		});
		const rectangleLayout = computeCompositeLayout({
			canvasSize: { width: 1920, height: 1080 },
			screenSize: { width: 1920, height: 1080 },
			webcamSize: { width: 1280, height: 720 },
			webcamMaskShape: "rectangle",
		});

		expect(roundedLayout?.webcamRect).not.toBeNull();
		expect(rectangleLayout?.webcamRect).not.toBeNull();
		expect(roundedLayout?.webcamRect?.borderRadius).toBeGreaterThan(
			rectangleLayout?.webcamRect?.borderRadius ?? 0,
		);
		expect(roundedLayout?.webcamRect?.maskShape).toBe("rounded");
	});
});
