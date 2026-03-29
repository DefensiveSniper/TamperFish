const fs = require('fs');
const path = require('path');

const manifestPath = path.join(process.cwd(), '.browser-media-cache', 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.log('{}');
  process.exit(0);
}

const raw = fs.readFileSync(manifestPath, 'utf8').trim();
console.log(raw || '{}');
