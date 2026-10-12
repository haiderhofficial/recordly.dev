import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "@/components/ui/toast";
import { resolveAutoCaptionSourcePath } from "../autoCaptionSource";
import {
	applySourceCuts,
	planDeadAirCuts,
	planFillerCuts,
	rippleAnchorsAfterCuts,
	rippleRegionsAfterCuts,
	type SourceRange,
} from "../speechTidy";
import type { AnnotationRegion, AudioRegion, CaptionCue, ClipRegion, ZoomRegion } from "../types";

type Translator = (
	key: string,
	fallback?: string,
	params?: Record<string, string | number>,
) => string;

export type TidyKind = "dead-air" | "filler";

export interface TidyPreview {
	kind: TidyKind;
	ranges: SourceRange[];
	removedMs: number;
}

interface UseSpeechTidyCommandsParams {
	t: Translator;
	videoPath: string | null;
	videoSourcePath: string | null;
	currentSourcePath: string | null;
	clipRegions: ClipRegion[];
	setClipRegions: Dispatch<SetStateAction<ClipRegion[]>>;
	setZoomRegions: Dispatch<SetStateAction<ZoomRegion[]>>;
	setAnnotationRegions: Dispatch<SetStateAction<AnnotationRegion[]>>;
	setAudioRegions: Dispatch<SetStateAction<AudioRegion[]>>;
	autoCaptions: CaptionCue[];
	setSelectedClipId: Dispatch<SetStateAction<string | null>>;
	nextClipIdRef: MutableRefObject<number>;
}

export function useSpeechTidyCommands({
	t,
	videoPath,
	videoSourcePath,
	currentSourcePath,
	clipRegions,
	setClipRegions,
	setZoomRegions,
	setAnnotationRegions,
	setAudioRegions,
	autoCaptions,
	setSelectedClipId,
	nextClipIdRef,
}: UseSpeechTidyCommandsParams) {
	const [isDetectingDeadAir, setIsDetectingDeadAir] = useState(false);
	const [tidyPreview, setTidyPreview] = useState<TidyPreview | null>(null);

	// Identity of the inputs that produced the current (or in-flight) preview.
	// Compared after the async IPC call to discard results for stale inputs.
	const previewInputRef = useRef({ videoSourcePath, videoPath, currentSourcePath, clipRegions, autoCaptions });
	if (
		previewInputRef.current.videoSourcePath !== videoSourcePath ||
		previewInputRef.current.videoPath !== videoPath ||
		previewInputRef.current.currentSourcePath !== currentSourcePath ||
		previewInputRef.current.clipRegions !== clipRegions ||
		previewInputRef.current.autoCaptions !== autoCaptions
	) {
		previewInputRef.current = { videoSourcePath, videoPath, currentSourcePath, clipRegions, autoCaptions };
	}

	useEffect(() => {
		setTidyPreview(null);
	}, [autoCaptions, clipRegions, currentSourcePath, videoPath, videoSourcePath]);

	const previewRanges = useCallback(
		(kind: TidyKind, ranges: SourceRange[]) => {
			if (ranges.length === 0) {
				toast.info(
					kind === "dead-air"
						? t("editor.tidy.noDeadAir", "No long pauses found.")
						: t("editor.tidy.noFiller", "No filler words found."),
				);
				return;
			}
			// Dry run: nothing changes until the user applies the preview.
			const { removedMs } = applySourceCuts(clipRegions, ranges, () => "");
			if (removedMs <= 0) {
				toast.info(t("editor.tidy.nothingToRemove", "Nothing to remove on the timeline."));
				return;
			}
			setTidyPreview({ kind, ranges, removedMs });
		},
		[clipRegions, t],
	);

	const handleRemoveDeadAir = useCallback(async () => {
		const sourcePath = resolveAutoCaptionSourcePath({
			videoSourcePath,
			videoPath,
			currentVideoPath: currentSourcePath,
		});
		if (!sourcePath) {
			toast.error(t("editor.tidy.noSource", "No source video is loaded"));
			return;
		}
		const inputAtStart = previewInputRef.current;
		setIsDetectingDeadAir(true);
		try {
			const result = await window.electronAPI.detectRecordingSilence({
				videoPath: sourcePath,
			});
			if (previewInputRef.current !== inputAtStart) return;
			if (!result.success || !result.intervals) {
				toast.error(
					t("editor.tidy.analyzeFailed", "Could not analyze the recording audio."),
				);
				return;
			}
			previewRanges("dead-air", planDeadAirCuts(result.intervals));
		} catch {
			toast.error(t("editor.tidy.analyzeFailed", "Could not analyze the recording audio."));
		} finally {
			setIsDetectingDeadAir(false);
		}
	}, [currentSourcePath, previewRanges, t, videoPath, videoSourcePath]);

	const handleRemoveFillerWords = useCallback(() => {
		previewRanges("filler", planFillerCuts(autoCaptions));
	}, [autoCaptions, previewRanges]);

	const handleApplyTidyPreview = useCallback(() => {
		if (!tidyPreview) return;
		const result = applySourceCuts(
			clipRegions,
			tidyPreview.ranges,
			() => `clip-${nextClipIdRef.current++}`,
		);
		setClipRegions(result.clips);
		setZoomRegions((current) => rippleRegionsAfterCuts(current, result.kept));
		setAnnotationRegions((current) => rippleRegionsAfterCuts(current, result.kept));
		setAudioRegions((current) => rippleAnchorsAfterCuts(current, result.kept));
		setSelectedClipId((current) =>
			current && result.clips.some((clip) => clip.id === current) ? current : null,
		);
		setTidyPreview(null);
	}, [
		clipRegions,
		nextClipIdRef,
		setAnnotationRegions,
		setAudioRegions,
		setClipRegions,
		setSelectedClipId,
		setZoomRegions,
		tidyPreview,
	]);

	const handleCancelTidyPreview = useCallback(() => setTidyPreview(null), []);

	return {
		isDetectingDeadAir,
		tidyPreview,
		handleRemoveDeadAir,
		handleRemoveFillerWords,
		handleApplyTidyPreview,
		handleCancelTidyPreview,
	};
}
