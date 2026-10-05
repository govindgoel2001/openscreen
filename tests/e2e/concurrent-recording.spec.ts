import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(ROOT, "tests/fixtures/sample.webm");
const RENDERER_DIR = path.join(ROOT, "dist");

async function serveRenderer() {
	const types: Record<string, string> = {
		".html": "text/html",
		".js": "text/javascript",
		".css": "text/css",
		".wasm": "application/wasm",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
	};
	const server = createServer((request, response) => {
		const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
		const file = path.resolve(RENDERER_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
		const relative = path.relative(RENDERER_DIR, file);
		if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file)) {
			response.writeHead(404).end();
			return;
		}
		response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
		response.end(fs.readFileSync(file));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Renderer server did not start");
	return { server, url: `http://127.0.0.1:${address.port}` };
}

for (const format of ["mp4", "gif"] as const) {
	// biome-ignore lint/correctness/noEmptyPattern: Electron tests do not use browser fixtures.
	test(`records another take while a ${format.toUpperCase()} export continues`, async ({}, testInfo) => {
		// Give this app its own data directory so tests never touch the user's
		// recordings, preferences, or running OpenScreen instance.
		const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-concurrent-"));
		const safeCleanupPath = path.dirname(path.resolve(testRoot)) === path.resolve(os.tmpdir());
		const userDataDir = path.join(testRoot, "user-data");
		fs.mkdirSync(userDataDir);
		const harnessPath = path.join(testRoot, "launch.cjs");
		fs.writeFileSync(
			harnessPath,
			`const { app } = require("electron");\napp.setPath("userData", ${JSON.stringify(userDataDir)});\nimport(${JSON.stringify(pathToFileURL(MAIN_JS).href)});\n`,
		);
		// The desktop shortcut runs the renderer over HTTP through Vite. Serve
		// the built assets over HTTP here to exercise that same environment.
		const renderer = await serveRenderer();
		const app = await electron.launch({
			args: [harnessPath, "--no-sandbox", "--enable-unsafe-swiftshader"],
			env: { ...process.env, HEADLESS: "true", VITE_DEV_SERVER_URL: renderer.url },
		});
		app.process().stderr?.on("data", (data) => process.stderr.write(`[electron] ${data}`));

		try {
			const recorder = await app.firstWindow();
			await recorder.waitForLoadState("domcontentloaded");
			const recordingsDir = path.join(userDataDir, "recordings");
			const firstVideo = path.join(recordingsDir, "first-take.webm");
			fs.mkdirSync(recordingsDir, { recursive: true });
			fs.copyFileSync(TEST_VIDEO, firstVideo);
			const fixtureBase64 = fs.readFileSync(TEST_VIDEO).toString("base64");

			await app.evaluate(({ ipcMain }, fixture) => {
				const state = globalThis as Record<string, unknown>;
				// Hold source loading until the next recording is live, then use the
				// real decoder/renderer/encoder. Hold saving until the second editor
				// opens, making the lifecycle assertions deterministic.
				state.__sourceGate = new Promise<void>((resolve) => {
					state.__releaseSource = resolve;
				});
				state.__saveGate = new Promise<void>((resolve) => {
					state.__releaseSave = resolve;
				});
				ipcMain.removeHandler("read-binary-file");
				ipcMain.handle("read-binary-file", async () => {
					state.__sourceRequests = ((state.__sourceRequests as number) || 0) + 1;
					await state.__sourceGate;
					const data = Buffer.from(fixture, "base64");
					return {
						success: true,
						data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
					};
				});
				ipcMain.removeHandler("save-exported-video");
				ipcMain.handle("save-exported-video", async (event, buffer: ArrayBuffer) => {
					state.__exportData = Buffer.from(buffer).toString("base64");
					state.__exportOwner = event.sender.id;
					await state.__saveGate;
					return { success: true, path: "test-export" };
				});
			}, fixtureBase64);

			const firstEditorPromise = app.waitForEvent("window", {
				predicate: (page) => page.url().includes("windowType=editor"),
			});
			await recorder.evaluate(async (videoPath) => {
				const result = await window.electronAPI.setCurrentVideoPath(videoPath);
				if (!result.success) throw new Error("Could not load test video");
				await window.electronAPI.switchToEditor();
			}, firstVideo);
			const firstEditor = await firstEditorPromise;
			firstEditor.on("console", (message) => {
				if (message.type() === "error" || /Exporter|Decoder/.test(message.text())) {
					process.stdout.write(`[first editor] ${message.text()}\n`);
				}
			});
			firstEditor.on("pageerror", (error) => process.stderr.write(`[first editor] ${error}\n`));
			// Electron may expose WebCodecs only after the second window reloads,
			// matching the initialization step in the standalone GIF export test.
			await firstEditor.reload();
			await firstEditor.waitForLoadState("domcontentloaded");
			await expect(firstEditor.getByTestId("testId-export-button")).toBeVisible();
			await expect(firstEditor.getByText("Loading video...")).not.toBeVisible();
			const firstWindow = await app.browserWindow(firstEditor);
			const firstId = await firstWindow.evaluate((win) => win.webContents.id);
			await firstEditor.evaluate(() => {
				(globalThis as Record<string, unknown>).__editorMarker = "first-editor-still-alive";
			});
			if (format === "gif") {
				await firstEditor.getByTestId("testId-gif-format-button").click();
				await firstEditor.getByTestId("testId-gif-size-button-medium").click();
			} else {
				await firstEditor.getByRole("button", { name: "Low", exact: true }).click();
			}
			await firstEditor.getByTestId("testId-export-button").click();
			const exportDialog = firstEditor.getByRole("dialog");
			const recordAgain = exportDialog.getByRole("button", { name: "Record again", exact: true });
			await expect(recordAgain).toBeVisible();
			await expect(
				exportDialog.getByText("Your export will keep processing in the background."),
			).toBeVisible();
			await exportDialog.screenshot({ path: testInfo.outputPath("record-again-dialog.png") });
			// Escape must preserve the active export and its action.
			await firstEditor.keyboard.press("Escape");
			await expect(recordAgain).toBeVisible();
			await recordAgain.focus();
			await firstEditor.keyboard.press("Enter");
			expect(firstEditor.isClosed()).toBe(false);
			expect(recorder.isClosed()).toBe(false);
			await expect.poll(() => firstWindow.evaluate((win) => win.isMinimized())).toBe(true);

			// Capture a generated canvas through the real MediaRecorder. No desktop,
			// microphone, or camera content is collected by this test.
			await recorder.evaluate(async () => {
				await window.electronAPI.selectSource({
					id: "screen:test:0",
					name: "Test source",
					display_id: "0",
					thumbnail: null,
					appIcon: null,
				});
				navigator.mediaDevices.getUserMedia = async () => {
					const canvas = document.createElement("canvas");
					canvas.width = 320;
					canvas.height = 180;
					const context = canvas.getContext("2d")!;
					const paint = () => {
						context.fillStyle = "#14532d";
						context.fillRect(0, 0, canvas.width, canvas.height);
						context.fillStyle = "white";
						context.fillText(`Second take ${performance.now().toFixed(0)}`, 20, 90);
						requestAnimationFrame(paint);
					};
					paint();
					return canvas.captureStream(30);
				};
			});
			const startRecording = recorder.getByRole("button", { name: "Start recording", exact: true });
			await expect(startRecording).toBeEnabled();
			await startRecording.click();
			const stopRecording = recorder.getByRole("button", { name: "Stop Recording", exact: true });
			await expect(stopRecording).toBeVisible();
			await app.evaluate(() => {
				((globalThis as Record<string, unknown>).__releaseSource as () => void)();
			});
			// Encoding must finish in the minimized first editor while the second
			// take is actively recording, before its native save call is released.
			await expect
				.poll(
					() => app.evaluate(() => Boolean((globalThis as Record<string, unknown>).__exportData)),
					{
						timeout: 60_000,
					},
				)
				.toBe(true)
				.catch(async (error) => {
					const state = await firstEditor
						.evaluate(() => document.body.innerText)
						.catch(() => "Editor closed before export diagnostics could be collected");
					process.stderr.write(`Export state: ${state}\n`);
					throw error;
				});
			await expect(stopRecording).toBeVisible();
			await expect(exportDialog.getByRole("button", { name: "Cancel Export" })).toBeVisible();
			const secondEditorPromise = app.waitForEvent("window", {
				predicate: (page) => page.url().includes("windowType=editor"),
			});
			await stopRecording.click();
			const secondEditor = await secondEditorPromise;
			await expect(secondEditor.getByTestId("testId-export-button")).toBeVisible();
			const secondSession = await secondEditor.evaluate(() =>
				window.electronAPI.getCurrentRecordingSession(),
			);
			expect(secondSession.success).toBe(true);
			expect(secondSession.session?.screenVideoPath).not.toBe(firstVideo);
			expect(fs.statSync(secondSession.session!.screenVideoPath).size).toBeGreaterThan(100);
			expect(
				await firstEditor.evaluate(() => (globalThis as Record<string, unknown>).__editorMarker),
			).toBe("first-editor-still-alive");
			expect(
				await firstEditor.evaluate(() => window.electronAPI.getCurrentVideoPath()),
			).toMatchObject({ success: true, path: firstVideo });
			expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__exportOwner)).toBe(
				firstId,
			);

			// Finalizing also keeps the recorder action available and reuses the HUD.
			await recordAgain.click();
			expect(
				app.windows().filter((page) => page.url().includes("windowType=hud-overlay")),
			).toHaveLength(1);
			await app.evaluate(() => {
				((globalThis as Record<string, unknown>).__releaseSave as () => void)();
			});
			await expect(
				firstEditor.getByText(`${format === "gif" ? "GIF" : "Video"} exported successfully`),
			).toBeVisible();
			const base64 = await app.evaluate(
				() => (globalThis as Record<string, unknown>).__exportData as string,
			);
			const output = Buffer.from(base64, "base64");
			expect(output.length).toBeGreaterThan(1024);
			if (format === "gif") expect(output.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
			else expect(output.subarray(4, 8).toString("ascii")).toBe("ftyp");

			// Saving another editor must not replace the original editor's trusted
			// save path or force it through Save As on its next save.
			const projectPaths = [
				path.join(testRoot, "first.openscreen"),
				path.join(testRoot, "second.openscreen"),
			];
			await app.evaluate(({ dialog }, paths) => {
				const state = globalThis as Record<string, unknown>;
				state.__saveDialogCalls = 0;
				dialog.showSaveDialog = (async () => {
					const index = state.__saveDialogCalls as number;
					state.__saveDialogCalls = index + 1;
					return { canceled: false, filePath: paths[index] };
				}) as typeof dialog.showSaveDialog;
			}, projectPaths);
			const firstProject = { version: 2, media: { screenVideoPath: firstVideo }, editor: {} };
			const secondProject = {
				version: 2,
				media: { screenVideoPath: secondSession.session!.screenVideoPath },
				editor: {},
			};
			expect(
				await firstEditor.evaluate(
					(project) => window.electronAPI.saveProjectFile(project),
					firstProject,
				),
			).toMatchObject({ success: true, path: projectPaths[0] });
			expect(
				await secondEditor.evaluate(
					(project) => window.electronAPI.saveProjectFile(project),
					secondProject,
				),
			).toMatchObject({ success: true, path: projectPaths[1] });
			expect(
				await firstEditor.evaluate(
					({ project, projectPath }) =>
						window.electronAPI.saveProjectFile(project, undefined, projectPath),
					{ project: firstProject, projectPath: projectPaths[0] },
				),
			).toMatchObject({ success: true, path: projectPaths[0] });
			expect(
				await app.evaluate(() => (globalThis as Record<string, unknown>).__saveDialogCalls),
			).toBe(2);
			expect(
				await firstEditor.evaluate(() => window.electronAPI.loadCurrentProjectFile()),
			).toMatchObject({ success: true, path: projectPaths[0] });
			expect(
				await secondEditor.evaluate(() => window.electronAPI.loadCurrentProjectFile()),
			).toMatchObject({ success: true, path: projectPaths[1] });

			// Unsaved-change guards and save-before-close replies belong to the
			// requesting editor, even when another editor is currently active.
			await firstEditor.evaluate(() => window.electronAPI.setHasUnsavedChanges(true));
			await secondEditor.evaluate(() => window.electronAPI.setHasUnsavedChanges(false));
			await app.evaluate(({ dialog }) => {
				(globalThis as Record<string, unknown>).__closePrompts = 0;
				dialog.showMessageBoxSync = (() => {
					const state = globalThis as Record<string, unknown>;
					state.__closePrompts = (state.__closePrompts as number) + 1;
					return 2;
				}) as typeof dialog.showMessageBoxSync;
			});
			await firstWindow.evaluate((win) => win.close());
			expect(firstEditor.isClosed()).toBe(false);
			expect(await app.evaluate(() => (globalThis as Record<string, unknown>).__closePrompts)).toBe(
				1,
			);
			const firstClosed = firstEditor.waitForEvent("close");
			await app.evaluate(({ dialog }, projectPath) => {
				dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
				dialog.showSaveDialog = (async () => ({
					canceled: false,
					filePath: projectPath,
				})) as typeof dialog.showSaveDialog;
			}, projectPaths[0]);
			await firstWindow.evaluate((win) => win.close());
			await firstClosed;
			expect(secondEditor.isClosed()).toBe(false);
		} finally {
			// These windows and files all belong to this isolated test instance.
			await app
				.evaluate(({ BrowserWindow }) => {
					for (const win of BrowserWindow.getAllWindows()) win.destroy();
				})
				.catch(() => {
					// The test app may already have exited after an assertion failure.
				});
			await app.close();
			await new Promise<void>((resolve) => renderer.server.close(() => resolve()));
			if (safeCleanupPath) fs.rmSync(testRoot, { recursive: true, force: true });
		}
	});
}
