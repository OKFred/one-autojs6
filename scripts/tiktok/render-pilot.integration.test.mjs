import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { renderPilot, measureTextPixels, verifyPixelLayout, validateManifest } from "./render-pilot.mjs";

const execute = promisify(execFile);

test("selected-font pixel metrics accept English copy and reject all-W overflow", { timeout: 30000 }, async () => {
  const candidates = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
  let font;
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) { font = candidate; break; } } catch { /* Try another local font. */ }
  }
  assert.ok(font, "A supported local font is required for exact metrics");
  const normal = await measureTextPixels("Wholesale enquiries", font, 50);
  assert.ok(normal.width > 0 && normal.width <= 840 && normal.height > 0 && normal.height <= 230);
  const overflow = await measureTextPixels("W".repeat(26), font, 50);
  assert.ok(overflow.width > 840, "Character count alone would wrongly accept this caption");
  const manifest = validateManifest({ videos: [0, 1, 2].map((index) => ({
    id: `overflow-${index}`, sku: "SHUSHA-DEMO", title: "Synthetic preview",
    images: ["a.jpg", "b.webp", "c.jpg", "d.webp"], frames: ["W".repeat(26), "Back view", "Detail view", "Ask us"],
  })) }, ".");
  await assert.rejects(verifyPixelLayout(manifest.videos, font), /safe pixel area/);
});

test("full synthetic JPEG/WebP pipeline produces exactly 540 limited-range frames per video", { timeout: 240000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "shusha-render-integration-"));
  try {
    const images = [];
    const combinations = [
      ["red", "800x1200", "jpg"], ["blue", "1200x800", "webp"],
      ["green", "640x640", "jpg"], ["yellow", "1280x720", "webp"],
      ["purple", "960x1280", "jpg"],
    ];
    for (const [index, [color, size, extension]] of combinations.entries()) {
      const filename = path.join(temporary, `synthetic-${index}.${extension}`);
      await execute(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=1`, "-frames:v", "1", "-threads", "1", filename], { windowsHide: true });
      images.push(filename);
    }
    const sourceHashes = await Promise.all(images.map(async (filename) =>
      createHash("sha256").update(await fs.readFile(filename)).digest("hex")));
    const manifest = { videos: [4, 5, 4].map((count, index) => ({
      id: `synthetic-${index}`, sku: `SHUSHA-DEMO-${index}`, title: "Synthetic style preview",
      images: images.slice(0, count), frames: Array.from({ length: count }, (_, frame) => `Synthetic frame ${frame + 1}`),
    })) };
    const manifestPath = path.join(temporary, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const report = await renderPilot(manifestPath);
    assert.equal(report.videos.length, 3);
    assert.ok(report.layoutMeasurements.filter((item) => item.overlay.startsWith("frame-")).every((item) => item.fontSize === 50 && item.width <= 840 && item.height <= 230));
    for (const video of report.videos) {
      const stream = video.ffprobe.streams[0];
      assert.equal(stream.width, 1080); assert.equal(stream.height, 1920);
      assert.equal(stream.nb_frames, "540"); assert.equal(stream.avg_frame_rate, "30/1");
      assert.equal(stream.pix_fmt, "yuv420p"); assert.equal(stream.color_range, "tv");
      assert.equal(video.ffprobe.streams.length, 1); assert.equal(Number(video.ffprobe.format.duration), 18);
      assert.equal(video.sha256, createHash("sha256").update(await fs.readFile(video.file)).digest("hex"));
      const { stdout } = await execute(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-count_frames",
        "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", video.file], { windowsHide: true });
      assert.equal(JSON.parse(stdout).streams[0].nb_read_frames, "540");
    }
    for (const [index, filename] of images.entries()) {
      assert.equal(createHash("sha256").update(await fs.readFile(filename)).digest("hex"), sourceHashes[index]);
    }
    await assert.rejects(renderPilot(manifestPath), /already exists/);
  } finally {
    if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(temporary).startsWith("shusha-render-integration-")) throw new Error("Unsafe temporary path");
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
