import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import fetch from "node-fetch";

const INPUT = process.argv[2] || "in";
const OUTPUT = process.argv[3] || "out";
const SIZE = parseInt(process.env.SIZE || "2000", 10);
const PADDING_PCT = parseFloat(process.env.PAD || "0.05"); // 5% breathing room
const V_BIAS_PCT = parseFloat(process.env.VBIAS || "-0.00"); // lift subject slightly
const ALPHA_THRESH = parseInt(process.env.ATHRESH || "16", 10); // 0–255

const HQ = process.env.HQ === "1";
if (HQ) {
  console.log("High-quality background removal mode enabled.");
}

const SMOOTH_THRESH = parseInt(process.env.SMOOTH_THRESH || "180", 10);
const SMOOTH_BLUR = parseFloat(process.env.SMOOTH_BLUR || "1.2");

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.resolve(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (/\.(jpe?g|png|webp|tiff?)$/i.test(d.name)) yield p;
  }
}

function expandBox([x0, y0, x1, y1], w, h, padPct) {
  const bw = x1 - x0,
    bh = y1 - y0;
  const pad = Math.round(Math.max(bw, bh) * padPct);
  return [
    Math.max(0, x0 - pad),
    Math.max(0, y0 - pad),
    Math.min(w, x1 + pad),
    Math.min(h, y1 + pad),
  ];
}

async function findAlphaBBoxAndCentroid(rgbaBuf) {
  const m = await sharp(rgbaBuf).metadata();
  const w = m.width,
    h = m.height;
  const a = await sharp(rgbaBuf).extractChannel("alpha").raw().toBuffer();

  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  let sumA = 0,
    sumX = 0,
    sumY = 0;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const alpha = a[row + x];
      if (alpha > ALPHA_THRESH) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        sumA += alpha;
        sumX += alpha * x;
        sumY += alpha * y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;

  const bbox = [x0, y0, x1 + 1, y1 + 1];
  const cx = sumX / sumA; // centroid in full-image coords
  const cy = sumY / sumA;
  return { bbox, cx, cy, w, h };
}

async function smoothAlpha(rgbaBuf) {
  const img = sharp(rgbaBuf);
  const meta = await img.metadata();
  const rgb = img.removeAlpha();
  const alpha = img
    .extractChannel("alpha")
    .blur(SMOOTH_BLUR)
    .threshold(SMOOTH_THRESH);
  const alphaBuf = await alpha.raw().toBuffer();
  const alphaImg = sharp(alphaBuf, {
    raw: { width: meta.width, height: meta.height, channels: 1 },
  });
  const alphaPng = await alphaImg.png().toBuffer();
  const rgbBuf = await rgb.raw().toBuffer();
  const rgbImg = sharp(rgbBuf, {
    raw: { width: meta.width, height: meta.height, channels: 3 },
  });
  const rgbPng = await rgbImg.png().toBuffer();
  // recombine rgb and smoothed alpha
  const combined = await sharp(rgbPng).joinChannel(alphaPng).png().toBuffer();
  return combined;
}

async function removeBgToRGBA(filePath) {
  let blob;
  if (HQ) {
    try {
      blob = await removeBackground(filePath, {
        outputType: "png",
        fast: false,
        model: "medium",
      });
    } catch {
      blob = await removeBackground(filePath);
    }
  } else {
    blob = await removeBackground(filePath); // PNG Blob with transparency
  }
  const buf = Buffer.from(await blob.arrayBuffer()); // -> Buffer
  let rgba = await sharp(buf).ensureAlpha().png().toBuffer(); // normalized RGBA
  if (HQ) {
    rgba = await smoothAlpha(rgba);
  }
  return rgba;
}

async function toSquareWebP(rgbaBuf, padPct = PADDING_PCT, centroid = null) {
  const img = sharp(rgbaBuf).ensureAlpha();
  const meta = await img.metadata();

  // content box inside the 2000x2000 canvas
  const maxContent = SIZE * (1 - padPct * 2);
  const scale = Math.min(maxContent / meta.width, maxContent / meta.height);

  const nw = Math.max(1, Math.floor(meta.width * scale));
  const nh = Math.max(1, Math.floor(meta.height * scale));

  // integer offsets only
  const by = Math.round(V_BIAS_PCT * SIZE);

  let left, top;
  if (centroid) {
    // centroid is relative to the crop image
    const cxScaled = centroid.cx * scale;
    const cyScaled = centroid.cy * scale;
    left = Math.round(SIZE / 2 - cxScaled);
    top = Math.round(SIZE / 2 - cyScaled + by);
  } else {
    left = Math.max(0, Math.floor((SIZE - nw) / 2));
    top = Math.max(0, Math.floor((SIZE - nh) / 2 + by));
  }

  const canvas = sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  const resized = await img.resize(nw, nh).toBuffer();

  return await canvas
    .composite([{ input: resized, left, top }])
    .webp({
      quality: parseInt(process.env.QUALITY || "82", 10), // image detail
      alphaQuality: parseInt(process.env.AQUALITY || "80", 10), // edge smoothness
      lossless: false,
      smartSubsample: true, // better chroma sampling for photos
      effort: parseInt(process.env.EFFORT || "6", 10), // 0–6, higher = smaller/slower
      nearLossless: false,
    })
    .toBuffer();
}

async function processOne(file) {
  const base = path.basename(file, path.extname(file));
  const noBg = await removeBgToRGBA(file);

  const meta = await sharp(noBg).metadata();
  const result = await findAlphaBBoxAndCentroid(noBg);
  let crop,
    centroid = null;
  if (result) {
    const bbox = result.bbox;
    crop = await sharp(noBg)
      .extract({
        left: bbox[0],
        top: bbox[1],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
      })
      .toBuffer();
    centroid = {
      cx: result.cx - bbox[0],
      cy: result.cy - bbox[1],
    };
  } else {
    crop = noBg;
  }

  const outBuf = await toSquareWebP(crop, PADDING_PCT, centroid);
  await fs.mkdir(OUTPUT, { recursive: true });
  const outPath = path.join(OUTPUT, `${base}.webp`);
  await fs.writeFile(outPath, outBuf);
  return outPath;
}

async function downloadToTemp(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  await fs.mkdir("downloaded", { recursive: true });
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  const baseName = path.basename(pathname) || "downloaded_image";
  const tempPath = path.join("downloaded", baseName);
  const buffer = await response.arrayBuffer();
  await fs.writeFile(tempPath, Buffer.from(buffer));
  return tempPath;
}

(async () => {
  await fs.mkdir(OUTPUT, { recursive: true });
  let n = 0;
  if (/^https?:\/\//i.test(INPUT)) {
    try {
      const localFile = await downloadToTemp(INPUT);
      const out = await processOne(localFile);
      console.log(`✓ ${path.basename(INPUT)} -> ${path.basename(out)}`);
      n = 1;
    } catch (err) {
      console.error(`Error processing URL ${INPUT}:`, err);
      process.exit(1);
    }
  } else {
    for await (const f of walk(INPUT)) {
      const out = await processOne(f);
      console.log(`✓ ${path.basename(f)} -> ${path.basename(out)}`);
      n++;
    }
  }
  console.log(`Done: ${n} files`);
})();
