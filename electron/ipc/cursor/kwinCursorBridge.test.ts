import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	buildKwinCursorScript,
	createDbusMonitorCursorParser,
	isKdeWaylandSession,
	KWIN_CURSOR_BRIDGE_INTERFACE,
	nextKwinObjectName,
	shouldSkipKdeWaylandSample,
	waitForChildReady,
	watchHelperExit,
} from "./kwinCursorBridge";

describe("isKdeWaylandSession", () => {
	it("accepts a KDE Plasma Wayland session", () => {
		expect(
			isKdeWaylandSession("linux", {
				XDG_SESSION_TYPE: "wayland",
				XDG_CURRENT_DESKTOP: "KDE",
			}),
		).toBe(true);
	});

	it("rejects X11, other desktops and other platforms", () => {
		expect(
			isKdeWaylandSession("linux", { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE" }),
		).toBe(false);
		expect(
			isKdeWaylandSession("linux", {
				XDG_SESSION_TYPE: "wayland",
				XDG_CURRENT_DESKTOP: "GNOME",
			}),
		).toBe(false);
		expect(
			isKdeWaylandSession("darwin", {
				XDG_SESSION_TYPE: "wayland",
				XDG_CURRENT_DESKTOP: "KDE",
			}),
		).toBe(false);
	});
});

describe("buildKwinCursorScript", () => {
	it("reports cursor moves to the bridge interface", () => {
		const script = buildKwinCursorScript();
		expect(script).toContain("workspace.cursorPosChanged.connect");
		expect(script).toContain(`"${KWIN_CURSOR_BRIDGE_INTERFACE}"`);
	});
});

describe("createDbusMonitorCursorParser", () => {
	const header = `method call time=1791644726.85 sender=:1.16 -> destination=${KWIN_CURSOR_BRIDGE_INTERFACE} serial=5200 path=/; interface=${KWIN_CURSOR_BRIDGE_INTERFACE}; member=Pos`;

	it("emits a point for each Pos call, across chunk boundaries", () => {
		const points: Array<{ x: number; y: number }> = [];
		const parser = createDbusMonitorCursorParser((point) => points.push(point));

		parser(`${header}\n   int32 1896\n   int`);
		parser(`32 557\n${header}\n   int32 -4\n   int32 12\n`);

		expect(points).toEqual([
			{ x: 1896, y: 557 },
			{ x: -4, y: 12 },
		]);
	});

	it("ignores unrelated bus traffic and incomplete calls", () => {
		const points: Array<{ x: number; y: number }> = [];
		const parser = createDbusMonitorCursorParser((point) => points.push(point));

		parser("signal time=1 sender=org.freedesktop.DBus member=NameAcquired\n   int32 7\n");
		parser(`${header}\n   int32 5\n${header}\n   int32 1\n   int32 2\n`);

		expect(points).toEqual([{ x: 1, y: 2 }]);
	});
});

describe("nextKwinObjectName", () => {
	it("is unique per call so a late unload cannot hit the next capture", () => {
		const first = nextKwinObjectName("recordly-cursor-bridge");
		const second = nextKwinObjectName("recordly-cursor-bridge");
		expect(first).not.toBe(second);
		expect(first.startsWith("recordly-cursor-bridge-")).toBe(true);
		expect(nextKwinObjectName("recordly_click_bridge", "_")).toMatch(
			/^recordly_click_bridge_\d+_\d+$/,
		);
	});
});

function createChild() {
	return Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
}

describe("waitForChildReady", () => {
	it("resolves on the first output", async () => {
		const child = createChild();
		const ready = waitForChildReady(child, 5000);

		child.stdout.emit("data", "signal ...");

		await expect(ready).resolves.toBeUndefined();
	});

	it("resolves after the timeout when a quiet helper is still running", async () => {
		vi.useFakeTimers();
		try {
			const ready = waitForChildReady(createChild(), 200);
			await vi.advanceTimersByTimeAsync(200);
			await expect(ready).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects when the helper cannot be started", async () => {
		const child = createChild();
		const ready = waitForChildReady(child, 5000);

		child.emit("error", new Error("spawn dbus-monitor ENOENT"));

		await expect(ready).rejects.toThrow(/ENOENT/);
	});

	it("rejects when the helper exits before it is ready", async () => {
		const child = createChild();
		const ready = waitForChildReady(child, 5000);

		child.emit("exit", 1);

		await expect(ready).rejects.toThrow(/exited/);
	});

	it("stops listening once ready, so a later exit is not an unhandled rejection", async () => {
		const child = createChild();
		const ready = waitForChildReady(child, 5000);
		child.stdout.emit("data", "x");
		await ready;

		expect(child.listenerCount("exit")).toBe(0);
		expect(child.listenerCount("error")).toBe(0);
	});
});

describe("watchHelperExit", () => {
	it("reports an exit that happened while the source was still starting", () => {
		const child = new EventEmitter();
		const helper = watchHelperExit(child);
		expect(helper.exited).toBe(false);

		child.emit("exit", 1);

		expect(helper.exited).toBe(true);
	});

	it("notifies the listener when a running helper exits", () => {
		const child = new EventEmitter();
		const onExit = vi.fn();
		watchHelperExit(child).onExit(onExit);

		child.emit("exit", null);

		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("stays quiet once the listener is cleared for an intended stop", () => {
		const child = new EventEmitter();
		const onExit = vi.fn();
		const helper = watchHelperExit(child);
		helper.onExit(onExit);
		helper.onExit(null);

		child.emit("exit", null);

		expect(onExit).not.toHaveBeenCalled();
	});
});

describe("shouldSkipKdeWaylandSample", () => {
	const now = 10_000;

	it("keeps compositor positions regardless of their age", () => {
		expect(
			shouldSkipKdeWaylandSample({ x: 1, y: 2, updatedAt: 0, logical: true }, false, now),
		).toBe(false);
	});

	it("skips everything else while the KWin source is starting or healthy", () => {
		expect(shouldSkipKdeWaylandSample(null, false, now)).toBe(true);
		expect(shouldSkipKdeWaylandSample({ x: 1, y: 2, updatedAt: now }, false, now)).toBe(true);
	});

	it("falls back to fresh X11 hook positions once the KWin source has failed", () => {
		expect(shouldSkipKdeWaylandSample({ x: 1, y: 2, updatedAt: now - 200 }, true, now)).toBe(
			false,
		);
		expect(shouldSkipKdeWaylandSample({ x: 1, y: 2, updatedAt: now - 5000 }, true, now)).toBe(
			true,
		);
		expect(shouldSkipKdeWaylandSample(null, true, now)).toBe(true);
	});
});
