import { readFile, writeFile, mkdir } from 'node:fs/promises';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let xml;
try {
  xml = await readFile(manifestPath, 'utf8');
} catch (error) {
  console.error('Android manifest not found at ' + manifestPath + ': ' + error.message);
  process.exit(1);
}

if (!/android:scheme="osudailytracker"/.test(xml)) {
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

}
const res='android/app/src/main/res';
await mkdir(res+'/drawable',{recursive:true});
await mkdir(res+'/mipmap-anydpi',{recursive:true});
await mkdir(res+'/mipmap-anydpi-v26',{recursive:true});
await mkdir(res+'/values',{recursive:true});
await writeFile(res+'/drawable/ic_launcher_foreground.xml',`<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">
<path android:fillColor="#111026" android:pathData="M28,28 L484,28 L484,484 L28,484 Z"/>
<path android:fillColor="#FF55BA" android:strokeColor="#FFD8F6" android:strokeWidth="9" android:pathData="M224,65 A145,145 0,1 0,224 355 A145,145 0,1 0,224 65"/>
<path android:fillColor="#FFFFFF" android:pathData="M112,185 L128,185 L128,235 L112,235 Z M148,185 L163,185 L163,235 L148,235 Z M180,185 L195,185 L195,235 L180,235 Z"/>
<path android:fillColor="#9C31FF" android:pathData="M95,367 L147,367 L147,428 L95,428 Z M160,338 L212,338 L212,428 L160,428 Z M225,305 L277,305 L277,428 L225,428 Z M290,267 L342,267 L342,428 L290,428 Z"/>
<path android:strokeColor="#FF4CA6" android:strokeWidth="12" android:strokeLineCap="round" android:fillColor="#00000000" android:pathData="M92,350 C155,337 177,291 225,310 S298,270 359,228"/>
<path android:fillColor="#43D9FF" android:pathData="M359,209 A19,19 0,1 0,359 247 A19,19 0,1 0,359 209"/>
<path android:fillColor="#10152B" android:strokeColor="#8FCaff" android:strokeWidth="9" android:pathData="M371,315 A56,56 0,1 0,371 427 A56,56 0,1 0,371 315"/>
<path android:strokeColor="#F2F8FF" android:strokeWidth="9" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="M371,340 L371,372 L394,386"/>
</vector>`, 'utf8');
await writeFile(res+'/mipmap-anydpi/ic_launcher.xml',`<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">
<path android:fillColor="#111026" android:pathData="M28,28 L484,28 L484,484 L28,484 Z"/>
<path android:fillColor="#FF55BA" android:strokeColor="#FFD8F6" android:strokeWidth="9" android:pathData="M224,65 A145,145 0,1 0,224 355 A145,145 0,1 0,224 65"/>
<path android:fillColor="#FFFFFF" android:pathData="M112,185 L128,185 L128,235 L112,235 Z M148,185 L163,185 L163,235 L148,235 Z M180,185 L195,185 L195,235 L180,235 Z"/>
<path android:fillColor="#9C31FF" android:pathData="M95,367 L147,367 L147,428 L95,428 Z M160,338 L212,338 L212,428 L160,428 Z M225,305 L277,305 L277,428 L225,428 Z M290,267 L342,267 L342,428 L290,428 Z"/>
</vector>`, 'utf8');
await writeFile(res+'/values/ic_launcher_background.xml',`<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#111026</color></resources>`,'utf8');
await writeFile(res+'/mipmap-anydpi-v26/ic_launcher.xml',`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>`,'utf8');
console.log('Generated custom launcher icon resources.');

const gradlePath='android/app/build.gradle';
let gradle=await readFile(gradlePath,'utf8');
gradle=gradle.replace(/versionCode\s+\d+/, 'versionCode 10000');
gradle=gradle.replace(/versionName\s+['"][^'"]*['"]/, 'versionName "1.0.0-alpha"');
const signingEnv=['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD'];
if(!signingEnv.every(key=>process.env[key])) {
  console.error('Stable APK signing is not configured. Add the four ANDROID_* GitHub Actions secrets before building Alpha.');
  process.exit(1);
}
const keystorePath='android/app/alpha-signing.keystore';
await writeFile(keystorePath,Buffer.from(process.env.ANDROID_KEYSTORE_BASE64,'base64'));
if(!gradle.includes('signingConfigs {')) {
  gradle=gradle.replace('android {','android {\n    signingConfigs { stable { storeFile file("alpha-signing.keystore"); storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD"); keyAlias System.getenv("ANDROID_KEY_ALIAS"); keyPassword System.getenv("ANDROID_KEY_PASSWORD") } }');
}
if(!gradle.includes('signingConfig signingConfigs.stable')) {
  gradle=gradle.replace('buildTypes {','buildTypes {\n        debug { signingConfig signingConfigs.stable }');
}
if(!gradle.includes('signingConfig signingConfigs.stable')) throw Error('Could not configure stable APK signing in generated Gradle file.');
await writeFile(gradlePath,gradle,'utf8');
console.log('Set Alpha version code/name and configured persistent APK signing.');
