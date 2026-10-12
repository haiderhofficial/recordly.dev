import { describe, expect, it } from "vitest";

import { getGpuSwitches, isLinuxX11Session } from "./gpuSwitches";

describe("isLinuxX11Session", () => {
	it("is false in a Wayland session", () => {
		expect(
			isLinuxX11Session({
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toBe(false);
	});

	it("is false when Wayland is explicitly requested via Ozone", () => {
		expect(
			isLinuxX11Session({
				OZONE_PLATFORM: "wayland",
				XDG_SESSION_TYPE: "x11",
			}),
		).toBe(false);
	});

	it("falls back to Electron's ozone hint when OZONE_PLATFORM is invalid", () => {
		expect(
			isLinuxX11Session({
				OZONE_PLATFORM: "auto",
				ELECTRON_OZONE_PLATFORM_HINT: "wayland",
				XDG_SESSION_TYPE: "x11",
			}),
		).toBe(false);
	});

	it("is true in an X11 session", () => {
		expect(isLinuxX11Session({ XDG_SESSION_TYPE: "x11" })).toBe(true);
	});

	it("is true when x11 is explicitly requested via Electron's ozone hint", () => {
		expect(
			isLinuxX11Session({
				ELECTRON_OZONE_PLATFORM_HINT: "x11",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toBe(true);
	});
});

describe("getGpuSwitches", () => {
	it("returns the Linux VAAPI workaround on Wayland", () => {
		expect(
			getGpuSwitches("linux", {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toEqual({
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		});
	});

	it("does not force EGL on Linux X11", () => {
		expect(getGpuSwitches("linux", { XDG_SESSION_TYPE: "x11" })).toEqual({
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		});
	});
});
