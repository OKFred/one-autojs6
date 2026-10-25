import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { validateManifest, wrapCopy, buildFilterGraph } from "./render-pilot.mjs";

/** Return synthetic render inputs without reading, copying or rendering assets. */
function fixture() {
  return { videos: ["sample-a", "sample-b", "sample-c"].map((id) => ({
    id, sku: "SHUSHA-DEMO", title: "Synthetic style preview",
    images: ["red.png", "blue.png", "green.png", "yellow.png"],
    frames: ["Front view", "Back view", "Detail view", "Ask about availability"],
  })) };
}

test("validates three local four-photo videos and resolves paths", () => {
  const result = validateManifest(fixture(), path.resolve("synthetic-private"));
  assert.equal(result.videos.length, 3);
  assert.equal(result.videos[0].images[0], path.resolve("synthetic-private", "red.png"));
  assert.equal(result.outputDirectory, path.resolve("synthetic-private", "rendered"));
});

test("supports five photos and rejects duplicates, URLs and malformed IDs", () => {
  const five = fixture();
  five.videos[0].images.push("white.png");
  five.videos[0].frames.push("A closer look");
  assert.equal(validateManifest(five, ".").videos[0].images.length, 5);
  for (const mutate of [
    (input) => { input.videos[0].id = undefined; },
    (input) => { input.videos[1].id = input.videos[0].id; },
    (input) => { input.videos[0].images[0] = "https://example.invalid/source.jpg"; },
    (input) => { input.videos[0].images[0] = input.videos[0].images[1]; },
    (input) => { input.videos[0].frames.pop(); },
    (input) => { input.videos.pop(); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => validateManifest(input, "."));
  }
});

test("copy wraps whole words and refuses overflow instead of cropping", () => {
  assert.equal(wrapCopy("A useful short caption", 14, 2), "A useful short\ncaption");
  assert.throws(() => wrapCopy("W".repeat(27), 26, 4), /safe text width/);
  assert.throws(() => wrapCopy("word ".repeat(100), 26, 4), /safe text area/);
  assert.throws(() => wrapCopy("\u4e2d\u6587", 26, 4), /English/);
});

test("render graph uses complete photo fit and isolated safe-area text", () => {
  const graph = buildFilterGraph(4);
  assert.match(graph, /force_original_aspect_ratio=decrease/);
  assert.doesNotMatch(graph, /crop=|zoompan=|overlay=/);
  assert.match(graph, /trim=end_frame=135/);
  assert.match(graph, /concat=n=4:v=1:a=0/);
  assert.equal((graph.match(/expansion=none/g) ?? []).length, 16);
  assert.match(buildFilterGraph(5), /trim=end_frame=108/);
  assert.match(graph, /out_range=tv/);
  assert.match(graph, /setpts=N\/\(30\*TB\)/);
  assert.match(graph, /scale=840:900:/);
  assert.match(graph, /fontsize=64:/);
  assert.match(graph, /textfile=frame-0.txt:expansion=none:fontsize=50:/);
  assert.match(graph, /drawbox=x=0:y=1260:/);
});
