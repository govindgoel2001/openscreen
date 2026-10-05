import { describe, expect, it } from "vitest";
import { pickCameraDevice } from "./useCameraDevices";

const devices = [
	{ deviceId: "builtin", label: "USB2.0 HD UVC WebCam", groupId: "g1" },
	{ deviceId: "gopro", label: "GoPro Webcam", groupId: "g2" },
];

describe("pickCameraDevice", () => {
	it("keeps the current selection while that camera is still attached", () => {
		expect(
			pickCameraDevice(devices, "gopro", { deviceId: "builtin", label: "USB2.0 HD UVC WebCam" }),
		).toBe("gopro");
	});

	it("restores the remembered camera by ID instead of taking the first one", () => {
		expect(pickCameraDevice(devices, "", { deviceId: "gopro", label: "GoPro Webcam" })).toBe(
			"gopro",
		);
	});

	it("restores the remembered camera by label when its ID has changed", () => {
		expect(pickCameraDevice(devices, "", { deviceId: "stale-id", label: "GoPro Webcam" })).toBe(
			"gopro",
		);
	});

	it("falls back to the first device when the remembered camera is unplugged", () => {
		expect(pickCameraDevice(devices, "", { deviceId: "c920", label: "HD Pro Webcam C920" })).toBe(
			"builtin",
		);
	});

	it("replaces a selection whose device has gone away", () => {
		expect(pickCameraDevice(devices, "c920", { deviceId: "gopro", label: "GoPro Webcam" })).toBe(
			"gopro",
		);
	});

	it("returns an empty string when no cameras are attached", () => {
		expect(pickCameraDevice([], "gopro", { deviceId: "gopro", label: "GoPro Webcam" })).toBe("");
	});

	it("ignores an empty remembered camera", () => {
		expect(pickCameraDevice(devices, "", { deviceId: null, label: null })).toBe("builtin");
	});
});
