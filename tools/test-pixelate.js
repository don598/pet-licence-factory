const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'Gemini_Generated_Image_z2emdcz2emdcz2em.png');
const SIZE = 128;
const PAL_LIMIT = 32;

async function run() {
  // Step 0: Load and get raw pixels at full res
  const img = sharp(INPUT);
  const meta = await img.metadata();
  console.log(`Source: ${meta.width}x${meta.height}, ${meta.channels} channels`);

  // Get full-res raw pixels
  const fullRaw = await sharp(INPUT).ensureAlpha().raw().toBuffer();
  const fw = meta.width, fh = meta.height;

  // Step 1: Detect background color from corners
  const getPixel = (x, y) => {
    const i = (y * fw + x) * 4;
    return [fullRaw[i], fullRaw[i+1], fullRaw[i+2], fullRaw[i+3]];
  };
  const corners = [[0,0],[fw-1,0],[0,fh-1],[fw-1,fh-1]];
  let bgR=0,bgG=0,bgB=0;
  for (const [cx,cy] of corners) {
    const [r,g,b] = getPixel(cx,cy);
    bgR+=r; bgG+=g; bgB+=b;
  }
  bgR=Math.round(bgR/4); bgG=Math.round(bgG/4); bgB=Math.round(bgB/4);
  console.log(`Background color: rgb(${bgR},${bgG},${bgB})`);

  // Step 2: Flood-fill background removal at full res
  const tolerance = 30;
  const tolSq = tolerance * tolerance * 3;
  const visited = new Uint8Array(fw * fh);
  const queue = [];

  // Seed edges
  for (let x = 0; x < fw; x++) { queue.push(x, 0); queue.push(x, fh-1); }
  for (let y = 1; y < fh-1; y++) { queue.push(0, y); queue.push(fw-1, y); }

  let bgRemoved = 0;
  let qi = 0;
  while (qi < queue.length) {
    const px = queue[qi++], py = queue[qi++];
    if (px < 0 || px >= fw || py < 0 || py >= fh) continue;
    const idx = py * fw + px;
    if (visited[idx]) continue;
    visited[idx] = 1;
    const i = idx * 4;
    const dr = fullRaw[i]-bgR, dg = fullRaw[i+1]-bgG, db = fullRaw[i+2]-bgB;
    if (dr*dr + dg*dg + db*db <= tolSq) {
      fullRaw[i+3] = 0;
      bgRemoved++;
      queue.push(px-1, py); queue.push(px+1, py);
      queue.push(px, py-1); queue.push(px, py+1);
    }
  }
  console.log(`Background removed: ${bgRemoved} pixels`);

  // Save bg-removed at full res for debugging
  await sharp(fullRaw, { raw: { width: fw, height: fh, channels: 4 } })
    .png().toFile(path.join(__dirname, 'debug-1-bg-removed.png'));

  // Step 3: Downscale to target size
  const downBuf = await sharp(fullRaw, { raw: { width: fw, height: fh, channels: 4 } })
    .resize(SIZE, SIZE, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
    .raw().toBuffer();

  console.log(`Downscaled to ${SIZE}x${SIZE}`);

  // Analyze the downscaled pixels
  let semiTransparent = 0, fullyOpaque = 0, fullyTransparent = 0;
  let grayEdgePixels = 0;

  for (let i = 0; i < downBuf.length; i += 4) {
    const a = downBuf[i+3];
    if (a === 0) fullyTransparent++;
    else if (a === 255) fullyOpaque++;
    else semiTransparent++;
  }
  console.log(`After downscale: ${fullyOpaque} opaque, ${semiTransparent} semi-transparent, ${fullyTransparent} transparent`);

  // Step 4: Alpha defringe
  for (let i = 0; i < downBuf.length; i += 4) {
    const a = downBuf[i+3];
    if (a === 0 || a === 255) continue;
    if (a < 128) {
      downBuf[i+3] = 0;
    } else {
      const factor = 255 / a;
      downBuf[i]   = Math.min(255, Math.round(downBuf[i] * factor));
      downBuf[i+1] = Math.min(255, Math.round(downBuf[i+1] * factor));
      downBuf[i+2] = Math.min(255, Math.round(downBuf[i+2] * factor));
      downBuf[i+3] = 255;
    }
  }

  // Count edge pixels and gray edge pixels
  const tw = SIZE, th = SIZE;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      if (downBuf[i+3] === 0) continue;

      let nearEdge = false;
      for (let dy = -1; dy <= 1 && !nearEdge; dy++) {
        for (let dx = -1; dx <= 1 && !nearEdge; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx < 0 || nx >= tw || ny < 0 || ny >= th) { nearEdge = true; continue; }
          if (downBuf[(ny*tw+nx)*4+3] === 0) nearEdge = true;
        }
      }

      if (nearEdge) {
        const r = downBuf[i], g = downBuf[i+1], b = downBuf[i+2];
        const maxC = Math.max(r,g,b), minC = Math.min(r,g,b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (sat < 0.25 && lum > 40 && lum < 220) {
          grayEdgePixels++;
        }
      }
    }
  }
  console.log(`Gray edge pixels found: ${grayEdgePixels}`);

  // Save after defringe
  await sharp(Buffer.from(downBuf), { raw: { width: tw, height: th, channels: 4 } })
    .png().toFile(path.join(__dirname, 'debug-2-defringed.png'));

  // Step 5: Fix gray edge pixels by borrowing from neighbors
  let fixed = 0;
  const buf2 = Buffer.from(downBuf); // work on a copy
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      if (downBuf[i+3] === 0) continue;

      let nearEdge = false;
      for (let dy = -1; dy <= 1 && !nearEdge; dy++) {
        for (let dx = -1; dx <= 1 && !nearEdge; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx < 0 || nx >= tw || ny < 0 || ny >= th) { nearEdge = true; continue; }
          if (downBuf[(ny*tw+nx)*4+3] === 0) nearEdge = true;
        }
      }

      if (nearEdge) {
        const r = downBuf[i], g = downBuf[i+1], b = downBuf[i+2];
        const maxC = Math.max(r,g,b), minC = Math.min(r,g,b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        const lum = r * 0.299 + g * 0.587 + b * 0.114;

        if (sat < 0.25 && lum > 40 && lum < 220) {
          // Find nearest saturated neighbor
          let bestColor = null, bestDist = Infinity;
          for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x+dx, ny = y+dy;
              if (nx < 0 || nx >= tw || ny < 0 || ny >= th) continue;
              const ni = (ny*tw+nx)*4;
              if (downBuf[ni+3] === 0) continue;
              const nr = downBuf[ni], ng = downBuf[ni+1], nb = downBuf[ni+2];
              const nSat = Math.max(nr,ng,nb) === 0 ? 0 : (Math.max(nr,ng,nb) - Math.min(nr,ng,nb)) / Math.max(nr,ng,nb);
              if (nSat >= 0.1) {
                const dist = dx*dx + dy*dy;
                if (dist < bestDist) { bestDist = dist; bestColor = [nr,ng,nb]; }
              }
            }
          }
          if (bestColor) {
            buf2[i] = bestColor[0]; buf2[i+1] = bestColor[1]; buf2[i+2] = bestColor[2];
            fixed++;
          } else {
            buf2[i+3] = 0;
            fixed++;
          }
        }
      }
    }
  }
  console.log(`Fixed ${fixed} gray edge pixels`);

  // Save after edge fix
  await sharp(Buffer.from(buf2), { raw: { width: tw, height: th, channels: 4 } })
    .png().toFile(path.join(__dirname, 'debug-3-edge-fixed.png'));

  // Also save a scaled-up version for easy comparison
  await sharp(Buffer.from(buf2), { raw: { width: tw, height: th, channels: 4 } })
    .resize(tw * 6, th * 6, { kernel: 'nearest' })
    .png().toFile(path.join(__dirname, 'debug-4-edge-fixed-6x.png'));

  await sharp(Buffer.from(downBuf), { raw: { width: tw, height: th, channels: 4 } })
    .resize(tw * 6, th * 6, { kernel: 'nearest' })
    .png().toFile(path.join(__dirname, 'debug-5-before-fix-6x.png'));

  console.log('Debug images saved!');
}

run().catch(console.error);
