import { readFile, writeFile, mkdir } from 'node:fs/promises';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let xml;
try {
  xml = await readFile(manifestPath, 'utf8');
} catch (error) {
  console.error('Android manifest not found at ' + manifestPath + ': ' + error.message);
  process.exit(1);
}

// Force Android to use the custom launcher artwork, including the round-icon slot.
xml = xml.replace(/<application\b([^>]*)>/, (match, attrs) => {
  let updated = attrs.replace(/\sandroid:icon="[^"]*"/, '').replace(/\sandroid:roundIcon="[^"]*"/, '');
  return '<application' + updated + ' android:icon="@drawable/ic_launcher_foreground" android:roundIcon="@drawable/ic_launcher_foreground"' + '>';
});
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
<path android:fillColor="#FF55BA" android:strokeColor="#FFD8F6" android:strokeWidth="10" android:pathData="M256,88 A168,168 0,1 0,256 424 A168,168 0,1 0,256 88"/>
<path android:fillColor="#111026" android:pathData="M256,150 A106,106 0,1 0,256 362 A106,106 0,1 0,256 150"/>
<path android:fillColor="#FFFFFF" android:pathData="M207,192 C219,181 241,184 252,194 L243,210 C235,204 223,203 219,211 C214,220 248,221 254,238 C261,258 242,274 223,271 C210,270 200,264 193,256 L205,240 C214,249 227,255 235,247 C242,238 210,236 204,223 C199,212 200,200 207,192 Z"/>
<path android:fillColor="#FFFFFF" android:pathData="M270,196 L288,196 L288,242 C288,255 294,262 304,262 C315,262 321,254 321,241 L321,196 L339,196 L339,277 L322,277 L322,267 C315,275 306,280 295,279 C277,279 270,266 270,248 Z"/>
<path android:fillColor="#9C31FF" android:pathData="M126,365 L180,365 L180,405 L126,405 Z M190,337 L244,337 L244,405 L190,405 Z M254,309 L308,309 L308,405 L254,405 Z M318,281 L372,281 L372,405 L318,405 Z"/>
<path android:strokeColor="#43D9FF" android:strokeWidth="11" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="M115,350 C166,336 190,300 239,313 S313,273 385,232"/>
<path android:fillColor="#43D9FF" android:pathData="M385,214 A18,18 0,1 0,385 250 A18,18 0,1 0,385 214"/>
</vector>`, 'utf8');
await writeFile(res+'/mipmap-anydpi/ic_launcher.xml',`<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">
<path android:fillColor="#111026" android:pathData="M28,28 L484,28 L484,484 L28,484 Z"/>
<path android:fillColor="#FF55BA" android:strokeColor="#FFD8F6" android:strokeWidth="9" android:pathData="M224,65 A145,145 0,1 0,224 355 A145,145 0,1 0,224 65"/>
<path android:fillColor="#FFFFFF" android:pathData="M100,175 C100,153 115,140 137,140 C159,140 174,153 174,175 L174,207 C174,229 159,242 137,242 C115,242 100,229 100,207 Z"/><path android:fillColor="#FF55BA" android:pathData="M118,176 C118,166 124,158 137,158 C150,158 156,166 156,176 L156,206 C156,216 150,224 137,224 C124,224 118,216 118,206 Z"/><path android:fillColor="#FFFFFF" android:pathData="M190,153 C203,143 225,146 238,157 L228,174 C219,167 205,166 201,174 C196,184 231,184 237,201 C244,222 225,239 205,236 C193,235 183,229 176,221 L188,205 C197,214 211,220 219,212 C226,203 193,201 187,188 C182,176 183,162 190,153 Z"/><path android:fillColor="#FFFFFF" android:pathData="M246,158 L264,158 L264,205 C264,218 270,225 280,225 C291,225 297,217 297,204 L297,158 L315,158 L315,239 L298,239 L298,229 C291,237 282,242 271,241 C253,241 246,228 246,210 Z"/><path android:fillColor="#FFFFFF" android:pathData="M328,144 L348,144 L344,205 L330,205 Z M330,217 L347,217 L347,238 L330,238 Z"/>
<path android:fillColor="#9C31FF" android:pathData="M95,367 L147,367 L147,428 L95,428 Z M160,338 L212,338 L212,428 L160,428 Z M225,305 L277,305 L277,428 L225,428 Z M290,267 L342,267 L342,428 L290,428 Z"/>
</vector>`, 'utf8');
await writeFile(res+'/drawable/ic_launcher_monochrome.xml',`<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">
<path android:fillColor="#FFFFFF" android:pathData="M256,88 A168,168 0,1 0,256 424 A168,168 0,1 0,256 88"/>
<path android:fillColor="#000000" android:pathData="M207,192 C219,181 241,184 252,194 L243,210 C235,204 223,203 219,211 C214,220 248,221 254,238 C261,258 242,274 223,271 C210,270 200,264 193,256 L205,240 C214,249 227,255 235,247 C242,238 210,236 204,223 C199,212 200,200 207,192 Z"/>
<path android:fillColor="#000000" android:pathData="M270,196 L288,196 L288,242 C288,255 294,262 304,262 C315,262 321,254 321,241 L321,196 L339,196 L339,277 L322,277 L322,267 C315,275 306,280 295,279 C277,279 270,266 270,248 Z"/>
</vector>`, 'utf8');
await writeFile(res+'/values/ic_launcher_background.xml',`<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#111026</color></resources>`,'utf8');
await writeFile(res+'/mipmap-anydpi-v26/ic_launcher.xml',`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/><monochrome android:drawable="@drawable/ic_launcher_monochrome"/></adaptive-icon>`,'utf8');
console.log('Generated custom launcher icon resources.');

const gradlePath='android/app/build.gradle';
let gradle=await readFile(gradlePath,'utf8');
gradle=gradle.replace(/versionCode\s+\d+/, 'versionCode 10706');
gradle=gradle.replace(/versionName\s+['"][^'"]*['"]/, 'versionName "1.7.6"');
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
