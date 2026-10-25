import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BACKGROUND = "0xf2efe8";
const FOREST = "0x153e35";
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const DURATION = 18;

/**
 * Validate English overlay copy and wrap complete words within a safe text width.
 * @param {unknown} value English title or caption supplied for human review.
 * @param {number} width Maximum ASCII characters per line.
 * @param {number} lines Maximum display lines.
 * @returns {string} Wrapped plain text; no drawtext expressions are evaluated.
 */
export function wrapCopy(value, width, lines) {
  if (typeof value !== "string" || !value.trim() || !/^[\x20-\x7e\r\n]+$/.test(value)) {
    throw new Error("Overlay copy must be nonempty printable English text");
  }
  const words = value.trim().split(/\s+/);
  const output = [""];
  for (const word of words) {
    if (word.length > width) throw new Error("Overlay word exceeds safe text width");
    const index = output.length - 1;
    if (!output[index]) output[index] = word;
    else if (output[index].length + word.length + 1 <= width) output[index] += ` ${word}`;
    else output.push(word);
  }
  if (output.length > lines) throw new Error("Overlay copy exceeds safe text area");
  return output.join("\n");
}

/**
 * Validate a local three-video manifest without opening assets or starting ffmpeg.
 * @param {unknown} value Parsed local JSON manifest.
 * @param {string} baseDirectory Directory used to resolve local image/font paths.
 * @returns {object} Validated, normalized local render inputs.
 */
export function validateManifest(value, baseDirectory) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray(value.videos) || value.videos.length !== 3) {
    throw new Error("Manifest must contain exactly three videos");
  }
  const identifiers = new Set();
  const videos = value.videos.map((video) => {
    if (!video || typeof video.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(video.id) || identifiers.has(video.id)) {
      throw new Error("Video IDs must be unique lowercase filename-safe identifiers");
    }
    identifiers.add(video.id);
    if (typeof video.sku !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(video.sku)) {
      throw new Error("A short visible SKU is required");
    }
    if (!Array.isArray(video.images) || ![4, 5].includes(video.images.length) ||
        !Array.isArray(video.frames) || video.frames.length !== video.images.length) {
      throw new Error("Each video needs four or five photos and one caption per photo");
    }
    const images = video.images.map((image) => {
      if (typeof image !== "string" || !image || /^[a-z][a-z0-9+.-]*:\/\//i.test(image) ||
          !/\.(?:jpg|jpeg|png|webp)$/i.test(image)) throw new Error("Photos must be local image files");
      return path.resolve(baseDirectory, image);
    });
    if (new Set(images).size !== images.length) throw new Error("Each photo must be distinct");
    return { id: video.id, sku: video.sku, title: wrapCopy(video.title, 26, 2),
      images, frames: video.frames.map((frame) => wrapCopy(frame, 26, 4)) };
  });
  const outputDirectory = path.resolve(baseDirectory, value.outputDirectory ?? "rendered");
  const fontFile = value.fontFile ? path.resolve(baseDirectory, value.fontFile) : undefined;
  return { videos, outputDirectory, fontFile };
}

/**
 * Build restrained portrait video filters with full-photo fit and separate copy.
 * @param {number} count Number of original photos, four or five.
 * @returns {string} ffmpeg graph referencing temporary local plain-text files.
 */
export function buildFilterGraph(count) {
  if (![4, 5].includes(count)) throw new Error("Four or five photos required");
  const frames = FPS * DURATION / count;
  const filters = Array.from({ length: count }, (_, index) =>
    `[${index}:v]scale=840:900:force_original_aspect_ratio=decrease:out_range=tv,` +
    `format=yuv420p,setparams=range=limited,` +
    `pad=840:900:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND},setsar=1,` +
    `pad=${WIDTH}:${HEIGHT}:90:330:color=${BACKGROUND},fps=${FPS},` +
    `drawbox=x=0:y=1260:w=iw:h=660:color=${FOREST}:t=fill,` +
    `drawtext=fontfile=font.ttf:textfile=brand.txt:expansion=none:fontsize=64:fontcolor=${FOREST}:x=90:y=132,` +
    `drawtext=fontfile=font.ttf:textfile=title.txt:expansion=none:fontsize=40:line_spacing=10:fontcolor=${FOREST}:x=90:y=210,` +
    `drawtext=fontfile=font.ttf:textfile=sku.txt:expansion=none:fontsize=28:fontcolor=white:x=90:y=1295,` +
    `drawtext=fontfile=font.ttf:textfile=frame-${index}.txt:expansion=none:fontsize=50:line_spacing=10:fontcolor=white:x=90:y=1365,` +
    `format=yuv420p,trim=end_frame=${frames},setpts=N/(${FPS}*TB)[v${index}]`);
  filters.push(Array.from({ length: count }, (_, index) => `[v${index}]`).join("") +
    `concat=n=${count}:v=1:a=0,fps=${FPS},setpts=N/(${FPS}*TB),format=yuv420p,setparams=range=limited[outv]`);
  return filters.join(";\n");
}

/**
 * Invoke a local binary with an argument array and bounded captured diagnostics.
 * @param {string} executable ffmpeg or ffprobe executable.
 * @param {string[]} args Literal process arguments, never shell-expanded.
 * @param {string} cwd Private temporary working directory.
 * @param {boolean} diagnostics Whether to return bounded stderr metrics instead.
 * @returns {Promise<string>} Captured standard output or diagnostic metrics.
 */
async function run(executable, args, cwd, diagnostics = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(diagnostics ? stderr : stdout) :
      reject(new Error(`${path.basename(executable)} failed (${code}): ${stderr}`)));
  });
}

/**
 * Measure exact drawtext glyph bounds with the same local font used for render.
 * @param {string} text Already wrapped plain overlay copy.
 * @param {string} fontFile Selected local font path.
 * @param {number} fontSize Exact renderer font size.
 * @param {number} lineSpacing Exact renderer line spacing.
 * @returns {Promise<{width: number, height: number}>} Actual ffmpeg pixel bounds.
 */
export async function measureTextPixels(text, fontFile, fontSize, lineSpacing = 10) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "shusha-measure-"));
  try {
    await fs.copyFile(fontFile, path.join(temporary, "font.ttf"));
    await fs.writeFile(path.join(temporary, "text.txt"), text, "utf8");
    const filter = `drawtext=fontfile=font.ttf:textfile=text.txt:expansion=none:fontsize=${fontSize}:line_spacing=${lineSpacing}:` +
      "x='print(1000000+text_w,16)*0':y='print(2000000+text_h,16)*0'";
    const diagnostics = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=1:d=1", "-vf", filter,
      "-frames:v", "1", "-f", "null", "-"], temporary, true);
    const values = diagnostics.split(/\r?\n/).filter((line) => /^\d+\.\d+$/.test(line.trim())).map(Number);
    const width = values.find((value) => value >= 1000000 && value < 2000000);
    const height = values.find((value) => value >= 2000000 && value < 3000000);
    if (width === undefined || height === undefined) throw new Error("Exact font pixel metrics unavailable");
    return { width: width - 1000000, height: height - 2000000 };
  } finally {
    if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(temporary).startsWith("shusha-measure-")) throw new Error("Unsafe temporary path");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Check every overlay's exact font bounds before rendering any campaign video.
 * @param {object[]} videos Validated and wrapped manifest videos.
 * @param {string} fontFile Selected local font used in the final render.
 * @returns {Promise<object[]>} Private layout metrics without original copy.
 */
export async function verifyPixelLayout(videos, fontFile) {
  const measurements = [];
  for (const video of videos) {
    const overlays = [
      { label: "brand", text: "SHUSHA", size: 64, maximumHeight: 80 },
      { label: "title", text: video.title, size: 40, maximumHeight: 100 },
      { label: "sku", text: video.sku, size: 28, maximumHeight: 40 },
      ...video.frames.map((text, index) => ({ label: `frame-${index}`, text, size: 50, maximumHeight: 230 })),
    ];
    for (const overlay of overlays) {
      const metrics = await measureTextPixels(overlay.text, fontFile, overlay.size);
      if (metrics.width > 840 || metrics.height > overlay.maximumHeight) {
        throw new Error(`Overlay exceeds safe pixel area: ${video.id}/${overlay.label} (${metrics.width}x${metrics.height})`);
      }
      measurements.push({ id: video.id, overlay: overlay.label, fontSize: overlay.size, ...metrics });
    }
  }
  return measurements;
}

/**
 * Hash exact local bytes for the private review/provenance report.
 * @param {string} filename Local asset or rendered video path.
 * @returns {Promise<string>} Lowercase SHA-256.
 */
async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Locate a local font without fetching any assets or dependencies.
 * @param {string | undefined} configured Explicit local font path.
 * @returns {Promise<string>} Existing font file path.
 */
async function resolveFont(configured) {
  const candidates = configured ? [configured] : [
    "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try next local font. */ }
  }
  throw new Error("Supply a local fontFile; no font is downloaded automatically");
}

/**
 * Render three private silent review videos; existing outputs are never replaced.
 * @param {string} manifestPath Local reviewed-input manifest path.
 * @returns {Promise<object>} Private metadata report including ffprobe and hashes.
 */
export async function renderPilot(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = validateManifest(JSON.parse(await fs.readFile(absoluteManifest, "utf8")), path.dirname(absoluteManifest));
  const font = await resolveFont(manifest.fontFile);
  await fs.mkdir(manifest.outputDirectory, { recursive: true });
  const reportPath = path.join(manifest.outputDirectory, "render-report.private.json");
  for (const target of [reportPath, ...manifest.videos.flatMap((video) => [
    path.join(manifest.outputDirectory, `${video.id}.mp4`),
    path.join(manifest.outputDirectory, `${video.id}.partial.mp4`),
  ])]) {
    try { await fs.access(target); throw new Error("Output already exists; choose a new private output directory"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const layoutMeasurements = await verifyPixelLayout(manifest.videos, font);
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(),
    design: "shusha-full-photo-fit-v2", width: WIDTH, height: HEIGHT, fps: FPS,
    durationSeconds: DURATION, audio: false, fontSha256: await fileHash(font), layoutMeasurements, videos: [] };
  for (const video of manifest.videos) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "shusha-render-"));
    const partial = path.join(manifest.outputDirectory, `${video.id}.partial.mp4`);
    const target = path.join(manifest.outputDirectory, `${video.id}.mp4`);
    try {
      await fs.copyFile(font, path.join(temporary, "font.ttf"));
      await fs.writeFile(path.join(temporary, "brand.txt"), "SHUSHA", "utf8");
      await fs.writeFile(path.join(temporary, "title.txt"), video.title, "utf8");
      await fs.writeFile(path.join(temporary, "sku.txt"), video.sku, "utf8");
      const sources = [];
      for (let index = 0; index < video.images.length; index++) {
        const filename = video.images[index];
        if (!(await fs.stat(filename)).isFile()) throw new Error("Original photo is not a regular file");
        sources.push({ path: filename, sha256: await fileHash(filename) });
        await fs.writeFile(path.join(temporary, `frame-${index}.txt`), video.frames[index], "utf8");
      }
      await fs.writeFile(path.join(temporary, "filters.txt"), buildFilterGraph(video.images.length), "utf8");
      const args = ["-hide_banner", "-loglevel", "error", "-n", "-filter_complex_threads", "1"];
      for (const image of video.images) args.push("-loop", "1", "-framerate", String(FPS), "-t", String(DURATION / video.images.length + 1), "-i", image);
      args.push("-filter_complex_script", "filters.txt", "-map", "[outv]", "-an", "-c:v", "libx264",
        "-preset", "medium", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv", "-threads", "2",
        "-r", String(FPS), "-fps_mode", "cfr", "-video_track_timescale", "30000",
        "-frames:v", String(FPS * DURATION), "-movflags", "+faststart", partial);
      await run(process.env.FFMPEG_PATH || "ffmpeg", args, temporary);
      const probe = JSON.parse(await run(process.env.FFPROBE_PATH || "ffprobe",
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", partial], temporary));
      const streams = probe.streams ?? [];
      const stream = streams.find((item) => item.codec_type === "video");
      const duration = Number(probe.format?.duration);
      if (streams.length !== 1 || stream?.width !== WIDTH || stream?.height !== HEIGHT ||
          stream?.codec_name !== "h264" || stream?.pix_fmt !== "yuv420p" ||
          stream?.color_range !== "tv" ||
          stream?.avg_frame_rate !== `${FPS}/1` || Number(stream?.nb_frames) !== FPS * DURATION ||
          !Number.isFinite(duration) || Math.abs(duration - DURATION) > 0.05) {
        throw new Error("Rendered output failed portrait/silent/duration verification");
      }
      for (const source of sources) {
        if (await fileHash(source.path) !== source.sha256) throw new Error("Original photo changed during rendering");
      }
      await fs.rename(partial, target);
      probe.format.filename = target;
      report.videos.push({ id: video.id, sku: video.sku, file: target,
        sha256: await fileHash(target), sources, ffprobe: probe });
    } finally {
      if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
          !path.basename(temporary).startsWith("shusha-render-")) throw new Error("Unsafe temporary path");
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return { reportPath, ...report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/tiktok/render-pilot.mjs <private-manifest.json>");
    process.exitCode = 1;
  } else {
    await renderPilot(process.argv[2]).then((report) => {
      console.log(JSON.stringify({ reportPath: report.reportPath, videos: report.videos.map(({ id, file, sha256 }) => ({ id, file, sha256 })) }));
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
