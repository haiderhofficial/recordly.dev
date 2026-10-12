import { packClipSequence } from "./clipSequence";
import {
	type CaptionCue,
	type ClipRegion,
	getClipSourceEndMs,
	getClipSourceStartMs,
	getSafeClipSpeed,
	sortClipRegions,
} from "./types";

/** A span in source (recording) time. */
export interface SourceRange {
	startMs: number;
	endMs: number;
}

/** A kept span of the old timeline. Time between kept spans was cut. */
export interface KeptSpan {
	startMs: number;
	endMs: number;
}

export interface SourceCutResult {
	clips: ClipRegion[];
	kept: KeptSpan[];
	removedMs: number;
}

/** Pauses shorter than this are normal speech rhythm and stay. */
export const DEAD_AIR_MIN_PAUSE_MS = 1_000;
/** A long pause is cut down to this total, split evenly around the cut. */
export const DEAD_AIR_KEEP_MS = 250;
/** Whole-word fillers only. "like" is left out because it is usually a real word. */
export const FILLER_WORDS: readonly string[] = ["um", "uh", "er", "ah"];

/** Silences are the ffmpeg `silencedetect` output. A trailing silence has `endMs: Infinity`. */
export function planDeadAirCuts(silences: SourceRange[]): SourceRange[] {
	const inset = DEAD_AIR_KEEP_MS / 2;
	return silences
		.filter((silence) => silence.endMs - silence.startMs >= DEAD_AIR_MIN_PAUSE_MS)
		.map((silence) => ({ startMs: silence.startMs + inset, endMs: silence.endMs - inset }));
}

export function planFillerCuts(cues: CaptionCue[]): SourceRange[] {
	return cues.flatMap((cue) =>
		(cue.words ?? [])
			.filter((word) => FILLER_WORDS.includes(word.text.toLowerCase().replace(/[^a-z]/g, "")))
			.map((word) => ({ startMs: word.startMs, endMs: word.endMs })),
	);
}

/**
 * Remove source-time ranges from the clip sequence, then close the gaps. Each clip is
 * split around the ranges it covers. The first piece keeps the clip id; later pieces
 * take `createId()`.
 */
export function applySourceCuts(
	clips: ClipRegion[],
	ranges: SourceRange[],
	createId: () => string,
): SourceCutResult {
	const ordered = sortClipRegions(clips);
	const pieces: ClipRegion[] = [];
	const kept: KeptSpan[] = [];

	for (const clip of ordered) {
		const speed = getSafeClipSpeed(clip);
		const sourceStartMs = getClipSourceStartMs(clip);
		const sourceEndMs = getClipSourceEndMs(clip);
		const cuts = ranges
			.map((range) => ({
				start: Math.max(range.startMs, sourceStartMs),
				end: Math.min(range.endMs, sourceEndMs),
			}))
			.filter((range) => range.end > range.start)
			.map((range) => ({
				startMs: clip.startMs + (range.start - sourceStartMs) / speed,
				endMs: clip.startMs + (range.end - sourceStartMs) / speed,
			}))
			.sort((left, right) => left.startMs - right.startMs);

		const spans: KeptSpan[] = [];
		let cursor = clip.startMs;
		for (const cut of cuts) {
			if (cut.startMs > cursor) spans.push({ startMs: cursor, endMs: cut.startMs });
			cursor = Math.max(cursor, cut.endMs);
		}
		if (cursor < clip.endMs) spans.push({ startMs: cursor, endMs: clip.endMs });

		for (const [index, span] of spans.entries()) {
			const startMs = Math.round(span.startMs);
			const endMs = Math.round(span.endMs);
			if (endMs <= startMs) continue;
			pieces.push({
				...clip,
				id: index === 0 ? clip.id : createId(),
				startMs,
				endMs,
				sourceStartMs: Math.round(sourceStartMs + (startMs - clip.startMs) * speed),
			});
			kept.push({ startMs, endMs });
		}
	}

	const packed = packClipSequence(pieces);
	const durationOf = (list: Array<{ startMs: number; endMs: number }>) =>
		list.reduce((total, item) => total + item.endMs - item.startMs, 0);
	return {
		clips: packed,
		kept,
		removedMs: durationOf(ordered) - durationOf(packed),
	};
}

/** Map a pre-cut timeline time to its post-cut time. Cut time collapses to the cut point. */
export function mapTimeAfterCuts(timeMs: number, kept: KeptSpan[]): number {
	let mapped = 0;
	for (const span of kept) {
		mapped += Math.min(Math.max(timeMs - span.startMs, 0), span.endMs - span.startMs);
	}
	return Math.round(mapped);
}

/** Regions wholly inside a cut are dropped. Regions across a cut shrink to what remains. */
export function rippleRegionsAfterCuts<T extends { startMs: number; endMs: number }>(
	regions: T[],
	kept: KeptSpan[],
): T[] {
	return regions.flatMap((region) => {
		const startMs = mapTimeAfterCuts(region.startMs, kept);
		const endMs = mapTimeAfterCuts(region.endMs, kept);
		return endMs > startMs ? [{ ...region, startMs, endMs }] : [];
	});
}

/** Imported audio keeps its duration. Only its timeline anchor moves. */
export function rippleAnchorsAfterCuts<T extends { startMs: number; endMs: number }>(
	regions: T[],
	kept: KeptSpan[],
): T[] {
	return regions.map((region) => {
		const startMs = mapTimeAfterCuts(region.startMs, kept);
		return { ...region, startMs, endMs: startMs + region.endMs - region.startMs };
	});
}
