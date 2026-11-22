const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'app', 'www');
const target = path.join(__dirname, 'www');

if (!fs.existsSync(path.join(source, 'index.html'))) {
  throw new Error('app/www/index.html not found. Run "npm run build" in app/ first.');
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'desktop-bridge.js'), path.join(target, 'native-bridge.bundle.js'));

console.log('Prepared desktop/www from app/www with the desktop native bridge.');
