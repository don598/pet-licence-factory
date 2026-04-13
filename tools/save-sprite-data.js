// This script reads the sprite data from stdin and saves it
const fs = require('fs');
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  fs.writeFileSync('sprite-data.json', input);
  console.log('Saved', (input.length/1024).toFixed(0), 'KB');
});
