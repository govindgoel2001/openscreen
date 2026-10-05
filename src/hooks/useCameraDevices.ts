import { useEffect, useRef, useState } from "react";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";

export interface CameraDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

export interface RememberedCamera {
	deviceId: string | null;
	label: string | null;
}

/**
 * Work out which camera to select from the devices currently attached.
 *
 * The current selection wins while the device is still plugged in. Otherwise the
 * remembered camera is matched by ID first, then by label, because a USB camera
 * that gets unplugged and reconnected often comes back with a fresh device ID.
 * Only when neither matches does this fall back to the first device, which is
 * the behaviour that used to pick the wrong camera every launch.
 */
export function pickCameraDevice(
	devices: CameraDevice[],
	currentDeviceId: string,
	remembered: RememberedCamera,
): string {
	if (currentDeviceId && devices.some((device) => device.deviceId === currentDeviceId)) {
		return currentDeviceId;
	}

	if (remembered.deviceId) {
		const byId = devices.find((device) => device.deviceId === remembered.deviceId);
		if (byId) return byId.deviceId;
	}

	if (remembered.label) {
		const byLabel = devices.find((device) => device.label === remembered.label);
		if (byLabel) return byLabel.deviceId;
	}

	return devices[0]?.deviceId ?? "";
}

export function useCameraDevices(enabled: boolean = false) {
	const [devices, setDevices] = useState<CameraDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selectedDeviceIdRef = useRef(selectedDeviceId);
	selectedDeviceIdRef.current = selectedDeviceId;

	useEffect(() => {
		if (!enabled) return;
		let mounted = true;

		const loadDevices = async () => {
			try {
				setIsLoading(true);
				setError(null);

				// Enumerate without requesting a second stream — the recorder handles
				// the real acquisition; unlabeled devices fall back to their device ID.
				const allDevices = await navigator.mediaDevices.enumerateDevices();
				const videoInputs = allDevices
					.filter((device) => device.kind === "videoinput")
					.map((device) => ({
						deviceId: device.deviceId,
						label: device.label || `Camera ${device.deviceId.slice(0, 8)}`,
						groupId: device.groupId,
					}));

				if (mounted) {
					setDevices(videoInputs);
					const prefs = loadUserPreferences();
					const nextId = pickCameraDevice(videoInputs, selectedDeviceIdRef.current, {
						deviceId: prefs.webcamDeviceId,
						label: prefs.webcamDeviceLabel,
					});
					if (nextId !== selectedDeviceIdRef.current) {
						setSelectedDeviceId(nextId);
					}
					setIsLoading(false);
				}
			} catch (err) {
				if (mounted) {
					setError(err instanceof Error ? err.message : "Failed to load cameras");
					setIsLoading(false);
				}
			}
		};

		loadDevices();

		navigator.mediaDevices.addEventListener("devicechange", loadDevices);
		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
		};
	}, [enabled]);

	// Remember the choice so the next launch opens on the same camera rather
	// than on whatever the OS happens to enumerate first.
	useEffect(() => {
		if (!selectedDeviceId) return;
		const selected = devices.find((device) => device.deviceId === selectedDeviceId);
		if (!selected) return;
		saveUserPreferences({
			webcamDeviceId: selected.deviceId,
			webcamDeviceLabel: selected.label,
		});
	}, [devices, selectedDeviceId]);

	return { devices, selectedDeviceId, setSelectedDeviceId, isLoading, error };
}
