import { readFile, writeFile } from 'node:fs/promises';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let xml;
try {
  xml = await readFile(manifestPath, 'utf8');
} catch (error) {
  console.error('Android manifest not found at ' + manifestPath + ': ' + error.message);
  process.exit(1);
}

if (/android:scheme="osudailytracker"/.test(xml)) {
  console.log('OAuth deep-link intent filter already exists.');
  process.exit(0);
}

const activityStart = xml.search(/<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*>/);
if (activityStart < 0) {
  console.error('Could not locate the generated MainActivity in AndroidManifest.xml.');
  process.exit(1);
}
const activityEnd = xml.indexOf('</activity>', activityStart);
if (activityEnd < 0) {
  console.error('MainActivity closing tag not found in AndroidManifest.xml.');
  process.exit(1);
}

const intentFilter = [
  '            <intent-filter>',
  '                <action android:name="android.intent.action.VIEW" />',
  '                <category android:name="android.intent.category.DEFAULT" />',
  '                <category android:name="android.intent.category.BROWSABLE" />',
  '                <data android:scheme="osudailytracker" android:host="oauth" />',
  '            </intent-filter>'
].join('\n');
xml = xml.slice(0, activityEnd) + intentFilter + '\n        ' + xml.slice(activityEnd);
await writeFile(manifestPath, xml, 'utf8');
console.log('Registered osudailytracker://oauth deep link on MainActivity.');
