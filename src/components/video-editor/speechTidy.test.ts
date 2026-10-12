import { describe, expect, it } from "vitest";
import {
	applySourceCuts,
	planDeadAirCuts,
	planFillerCuts,
	rippleAnchorsAfterCuts,
	rippleRegionsAfterCuts,
} from "./speechTidy";
import type { CaptionCue, ClipRegion } from "./types";

const ids = () => {
	let next = 0;
	return () => `new-${next++}`;
};

const clip = (
	overrides: Partial<ClipRegion> & Pick<ClipRegion, "id" | "startMs" | "endMs">,
): ClipRegion => ({
	speed: 1,
	...overrides,
});

describe("planDeadAirCuts", () => {
	it("shortens only pauses at least one second and keeps 250 ms around the cut", () => {
		expect(
			planDeadAirCuts([
				{ startMs: 0, endMs: 900 },
				{ startMs: 2_000, endMs: 4_000 },
				{ startMs: 5_000, endMs: Number.POSITIVE_INFINITY },
			]),
		).toEqual([
			{ startMs: 2_125, endMs: 3_875 },
			{ startMs: 5_125, endMs: Number.POSITIVE_INFINITY },
		]);
	});
});

describe("planFillerCuts", () => {
	it("matches listed fillers ignoring case and punctuation, and skips cues without words", () => {
		const cues: CaptionCue[] = [
			{
				id: "a",
				startMs: 0,
				endMs: 3_000,
				text: "Um, I think like so",
				words: [
					{ text: "Um,", startMs: 0, endMs: 300 },
					{ text: "I", startMs: 300, endMs: 400 },
					{ text: "like", startMs: 400, endMs: 600 },
					{ text: "UH", startMs: 600, endMs: 800 },
				],
			},
			{ id: "b", startMs: 3_000, endMs: 4_000, text: "ah" },
		];
		expect(planFillerCuts(cues)).toEqual([
			{ startMs: 0, endMs: 300 },
			{ startMs: 600, endMs: 800 },
		]);
	});
});

describe("applySourceCuts", () => {
	it("returns the clips unchanged when there is nothing to cut", () => {
		const clips = [clip({ id: "c1", startMs: 0, endMs: 1_000 })];
		const result = applySourceCuts(clips, [], ids());
		expect(result.clips).toEqual([{ ...clips[0], sourceStartMs: 0 }]);
		expect(result.removedMs).toBe(0);
	});

	it("splits a clip around a cut, keeps the first id, and closes the gap", () => {
		const result = applySourceCuts(
			[clip({ id: "c1", startMs: 0, endMs: 3_000 })],
			[{ startMs: 1_000, endMs: 1_500 }],
			ids(),
		);
		expect(result.clips).toEqual([
			{ id: "c1", startMs: 0, endMs: 1_000, speed: 1, sourceStartMs: 0 },
			{ id: "new-0", startMs: 1_000, endMs: 2_500, speed: 1, sourceStartMs: 1_500 },
		]);
		expect(result.removedMs).toBe(500);
	});

	it("maps source cuts through clip speed", () => {
		// 2x clip: 2000 ms of source plays as 1000 ms on the timeline.
		const result = applySourceCuts(
			[clip({ id: "c1", startMs: 0, endMs: 1_000, speed: 2 })],
			[{ startMs: 500, endMs: 1_500 }],
			ids(),
		);
		expect(result.clips).toEqual([
			{ id: "c1", startMs: 0, endMs: 250, speed: 2, sourceStartMs: 0 },
			{ id: "new-0", startMs: 250, endMs: 500, speed: 2, sourceStartMs: 1_500 },
		]);
		expect(result.removedMs).toBe(500);
	});

	it("drops a clip that a cut covers entirely and ignores cuts outside every clip", () => {
		const result = applySourceCuts(
			[
				clip({ id: "c1", startMs: 0, endMs: 1_000 }),
				clip({ id: "c2", startMs: 1_000, endMs: 2_000, sourceStartMs: 5_000 }),
			],
			[
				{ startMs: 0, endMs: 1_000 },
				{ startMs: 9_000, endMs: 9_500 },
			],
			ids(),
		);
		expect(result.clips).toEqual([
			{ id: "c2", startMs: 0, endMs: 1_000, speed: 1, sourceStartMs: 5_000 },
		]);
		expect(result.removedMs).toBe(1_000);
	});
});

describe("region ripple after cuts", () => {
	const kept = [
		{ startMs: 0, endMs: 1_000 },
		{ startMs: 1_500, endMs: 3_000 },
	];

	it("drops regions inside a cut and shrinks regions that cross it", () => {
		expect(
			rippleRegionsAfterCuts(
				[
					{ id: "inside", startMs: 1_100, endMs: 1_400 },
					{ id: "across", startMs: 800, endMs: 2_000 },
					{ id: "after", startMs: 2_000, endMs: 2_500 },
				],
				kept,
			),
		).toEqual([
			{ id: "across", startMs: 800, endMs: 1_500 },
			{ id: "after", startMs: 1_500, endMs: 2_000 },
		]);
	});

	it("moves audio anchors but keeps their duration", () => {
		expect(
			rippleAnchorsAfterCuts([{ id: "audio", startMs: 2_000, endMs: 2_600 }], kept),
		).toEqual([{ id: "audio", startMs: 1_500, endMs: 2_100 }]);
	});
});
