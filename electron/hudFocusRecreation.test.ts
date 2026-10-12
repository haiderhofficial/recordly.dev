import { describe, expect, it } from "vitest";
import { shouldRecreateHudToFocus } from "./hudFocusRecreation";

const idleHud = { platform: "linux", isHud: true, focused: false, captureInProgress: false };

describe("shouldRecreateHudToFocus", () => {
	it("recreates an idle, unfocused HUD on Linux", () => {
		expect(shouldRecreateHudToFocus(idleHud)).toBe(true);
	});

	it("keeps the HUD while it owns a capture", () => {
		expect(shouldRecreateHudToFocus({ ...idleHud, captureInProgress: true })).toBe(false);
	});

	it("keeps a HUD that already has focus", () => {
		expect(shouldRecreateHudToFocus({ ...idleHud, focused: true })).toBe(false);
	});

	it("leaves windows other than the HUD alone", () => {
		expect(shouldRecreateHudToFocus({ ...idleHud, isHud: false })).toBe(false);
	});

	it.each(["darwin", "win32"] as const)("never recreates the HUD on %s", (platform) => {
		expect(shouldRecreateHudToFocus({ ...idleHud, platform })).toBe(false);
	});
});
