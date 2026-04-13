const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/Users/donnydye/Desktop/Pet Licence Factory/sprite-data.json', 'utf8'));

const { width, height, palette, frames } = data;
const paletteKeys = Object.keys(palette);
const paletteArr = paletteKeys.map(k => palette[k]);
const keyToIdx = {};
paletteKeys.forEach((k, i) => { keyToIdx[k] = i; });

// Encode frame as flat array of indices (-1 for transparent)
const frame = frames[0];
const flat = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const cell = frame[y][x];
    flat.push(cell === '_' ? -1 : keyToIdx[cell]);
  }
}

const scale = 4;
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Animated Sprite</title>
<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;}canvas{image-rendering:pixelated;image-rendering:crisp-edges;}</style>
</head><body><canvas id="c"></canvas>
<script>
const W=${width},H=${height},S=${scale};
const P=${JSON.stringify(paletteArr)};
const F=new Int16Array(${JSON.stringify(Array.from(flat))});
const c=document.getElementById('c');
c.width=W*S;c.height=H*S+4;
const x=c.getContext('2d');
x.imageSmoothingEnabled=false;
function draw(ts){
  x.clearRect(0,0,c.width,c.height);
  const oy=Math.sin(ts/900)*1.5;
  for(let y=0;y<H;y++)for(let xx=0;xx<W;xx++){
    const ci=F[y*W+xx];
    if(ci>=0){x.fillStyle=P[ci];x.fillRect(xx*S,y*S+oy,S,S);}
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
<\/script></body></html>`;

fs.writeFileSync('/Users/donnydye/Desktop/Pet Licence Factory/bunny-sprite.html', html);
console.log('Generated! Palette:', paletteArr.length, 'colors, Frame:', flat.length, 'pixels');
console.log('File size:', (html.length / 1024).toFixed(1), 'KB');
