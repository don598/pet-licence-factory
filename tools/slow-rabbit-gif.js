// Slows the rabbit sprite GIF down to 5 FPS (200ms per frame)
// and saves it as public/images/rabbit-email.gif for use in emails.
// Run with: node tools/slow-rabbit-gif.js

const sharp = require('sharp');
const path  = require('path');

const SRC  = path.join(__dirname, '../public/images/Station 5 sprite.gif');
const DEST = path.join(__dirname, '../public/images/rabbit-email.gif');
const FPS  = 5;
const DELAY_MS = Math.round(1000 / FPS); // 200ms

(async () => {
  const img = sharp(SRC, { animated: true });
  const meta = await img.metadata();

  console.log(`Source frames : ${meta.pages}`);
  console.log(`Current delay : ${meta.delay} ms`);
  console.log(`New delay     : ${DELAY_MS} ms per frame (${FPS} FPS)`);

  const delay = Array(meta.pages || 1).fill(DELAY_MS);

  await sharp(SRC, { animated: true })
    .gif({ delay })
    .toFile(DEST);

  console.log(`✅  Saved → ${DEST}`);
})().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
