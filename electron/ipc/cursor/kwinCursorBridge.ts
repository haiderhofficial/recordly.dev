import { execFile, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const KWIN_CURSOR_BRIDGE_INTERFACE = "dev.recordly.CursorBridge";
const KWIN_SCRIPT_NAME = "recordly-cursor-bridge";
const KWIN_REPORT_INTERVAL_MS = 4;
const DBUS_MONITOR_READY_TIMEOUT_MS = 500;

export interface KwinCursorPoint {
	x: number;
	y: number;
}

// Wayland hides the global pointer from clients, so Electron's
// screen.getCursorScreenPoint() stays at 0,0 and the X11 input hook only sees
// XWayland windows. KWin exposes the real position to its own scripts.
export function isKdeWaylandSession(
	platform: NodeJS.Platform | string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (platform !== "linux" || env.XDG_SESSION_TYPE?.trim().toLowerCase() !== "wayland") {
		return false;
	}

	const desktops = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.XDG_SESSION_DESKTOP ?? ""}`
		.toLowerCase()
		.split(/[:;]/);
	return desktops.includes("kde") || env.KDE_FULL_SESSION === "true";
}

export function buildKwinCursorScript(): string {
	const iface = JSON.stringify(KWIN_CURSOR_BRIDGE_INTERFACE);
	return `var lastReportMs = 0;
function report(force) {
	var now = Date.now();
	if (!force && now - lastReportMs < ${KWIN_REPORT_INTERVAL_MS}) {
		return;
	}
	lastReportMs = now;
	callDBus(${iface}, "/", ${iface}, "Pos", workspace.cursorPos.x, workspace.cursorPos.y);
}
workspace.cursorPosChanged.connect(function () {
	report(false);
});
report(true);
`;
}

/** Parses `dbus-monitor` text output into the Pos(x, y) calls sent by the KWin script. */
export function createDbusMonitorCursorParser(onPoint: (point: KwinCursorPoint) => void) {
	const callMarker = `interface=${KWIN_CURSOR_BRIDGE_INTERFACE}; member=Pos`;
	let buffer = "";
	let pending: number[] | null = null;

	return (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (line.includes(callMarker)) {
				pending = [];
				continue;
			}

			const value = pending
				? line.match(/^\s+(?:int32|double)\s+(-?\d+(?:\.\d+)?)\s*$/)
				: null;
			if (!pending || !value) {
				pending = null;
				continue;
			}

			pending.push(Number(value[1]));
			if (pending.length === 2) {
				onPoint({ x: pending[0], y: pending[1] });
				pending = null;
			}
		}
	};
}

function callKwin(objectPath: string, method: string, args: string[] = []) {
	return execFileAsync(
		"gdbus",
		[
			"call",
			"--session",
			"--dest",
			"org.kde.KWin",
			"--object-path",
			objectPath,
			"--method",
			method,
			...args,
		],
		{ timeout: 3000 },
	);
}

interface ReadyAwaitableChild extends EventEmitter {
	stdout?: EventEmitter | null;
}

/**
 * Resolves on the helper's first output, or after `timeoutMs` if it is still
 * running quietly. Rejects if it cannot be started or exits first, so a missing
 * tool is reported instead of leaving a recording without telemetry.
 */
export function waitForChildReady(child: ReadyAwaitableChild, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const settle = (error?: Error) => {
			clearTimeout(timer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.stdout?.removeListener("data", onData);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onError = (error: Error) => settle(error);
		const onExit = (code: number | null) =>
			settle(new Error(`Helper process exited before it was ready (code ${code}).`));
		const onData = () => settle();
		const timer = setTimeout(() => settle(), timeoutMs);

		child.once("error", onError);
		child.once("exit", onExit);
		child.stdout?.once("data", onData);
	});
}

/**
 * Tracks a helper that dies on its own. `exited` covers the startup steps that
 * follow readiness; the listener covers the rest of the capture.
 */
export function watchHelperExit(child: EventEmitter) {
	let exited = false;
	let listener: (() => void) | null = null;
	child.once("exit", () => {
		exited = true;
		listener?.();
	});

	return {
		get exited() {
			return exited;
		},
		onExit(next: (() => void) | null) {
			listener = next;
		},
	};
}

/**
 * On KDE Wayland Electron only reports 0,0, so samples wait for a compositor
 * position. X11 hook positions are used only once the KWin source has failed.
 */
export function shouldSkipKdeWaylandSample(
	point: { updatedAt: number; logical?: boolean } | null,
	positionSourceFailed: boolean,
	nowMs: number,
): boolean {
	if (point?.logical) {
		return false;
	}

	return !(positionSourceFailed && point !== null && nowMs - point.updatedAt <= 1000);
}

let kwinObjectCounter = 0;

/** Unique per start, so a late unload from a previous capture cannot hit the next one. */
export function nextKwinObjectName(prefix: string, separator = "-"): string {
	kwinObjectCounter += 1;
	return [prefix, process.pid, kwinObjectCounter].join(separator);
}

/**
 * Streams the global cursor position from KWin. Resolves with a stop function.
 * `onExit` runs if the monitor dies later, after the script has been unloaded.
 */
export async function startKwinCursorBridge(
	onPoint: (point: KwinCursorPoint) => void,
	onExit?: () => void,
): Promise<() => void> {
	const scriptName = nextKwinObjectName(KWIN_SCRIPT_NAME);
	const scriptPath = path.join(os.tmpdir(), `${scriptName}.js`);
	const monitor = spawn(
		"dbus-monitor",
		["--session", `type='method_call',interface='${KWIN_CURSOR_BRIDGE_INTERFACE}'`],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	// Keep a handler for the monitor's whole lifetime: an unhandled "error" would
	// take down the main process.
	monitor.on("error", () => undefined);
	const helper = watchHelperExit(monitor);
	const stop = () => {
		helper.onExit(null);
		monitor.kill();
		void callKwin("/Scripting", "org.kde.kwin.Scripting.unloadScript", [scriptName])
			.catch(() => undefined)
			.then(() => fs.rm(scriptPath, { force: true }))
			.catch(() => undefined);
	};

	try {
		monitor.stdout?.setEncoding("utf-8");
		const ready = waitForChildReady(monitor, DBUS_MONITOR_READY_TIMEOUT_MS);
		monitor.stdout?.on("data", createDbusMonitorCursorParser(onPoint));
		await ready;

		await fs.writeFile(scriptPath, buildKwinCursorScript(), "utf-8");
		await callKwin("/Scripting", "org.kde.kwin.Scripting.unloadScript", [scriptName]).catch(
			() => undefined,
		);
		const { stdout } = await callKwin("/Scripting", "org.kde.kwin.Scripting.loadScript", [
			scriptPath,
			scriptName,
		]);
		const scriptId = Number(stdout.match(/\((-?\d+),\)/)?.[1] ?? Number.NaN);
		if (!Number.isInteger(scriptId) || scriptId < 0) {
			throw new Error(`KWin refused the cursor script: ${stdout.trim()}`);
		}
		await callKwin(`/Scripting/Script${scriptId}`, "org.kde.kwin.Script.run");
		if (helper.exited) {
			throw new Error("dbus-monitor exited while the cursor script was loading.");
		}
	} catch (error) {
		stop();
		throw error;
	}

	helper.onExit(() => {
		stop();
		onExit?.();
	});
	return stop;
}
