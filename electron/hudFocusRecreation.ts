/**
 * Wayland compositors ignore focus(), so an unfocused HUD is destroyed and
 * recreated to bring it forward. Its renderer owns the capture stream and the
 * recorded data, so that has to wait while a recording is starting, running
 * or being saved. Any other window is left alone: it may still be loading, or
 * hold unsaved work.
 */
export function shouldRecreateHudToFocus({
	platform,
	isHud,
	focused,
	captureInProgress,
}: {
	platform: string;
	isHud: boolean;
	focused: boolean;
	captureInProgress: boolean;
}): boolean {
	return platform === "linux" && isHud && !focused && !captureInProgress;
}
