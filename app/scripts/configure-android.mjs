import { readFile, writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

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
  return '<application' + updated + ' android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"' + '>';
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
  console.log('Registered osudailytracker://oauth deep link on MainActivity.');
}
await writeFile(manifestPath, xml, 'utf8');
console.log('Applied launcher icon resources and saved AndroidManifest.xml.');
const res='android/app/src/main/res';
await mkdir(res+'/drawable',{recursive:true});
await mkdir(res+'/mipmap-anydpi-v26',{recursive:true});
await mkdir(res+'/values',{recursive:true});
// Generate density-specific legacy icons from the checked-in artwork; Android 8+ uses adaptive icons.
const iconSvg=await readFile('www/icon.svg');
for(const [density,size] of [['mdpi',48],['hdpi',72],['xhdpi',96],['xxhdpi',144],['xxxhdpi',192]]) {
  const dir=res+'/mipmap-'+density;
  await mkdir(dir,{recursive:true});
  await sharp(iconSvg).resize(size,size,{fit:'contain'}).png().toFile(dir+'/ic_launcher.png');
  await sharp(iconSvg).resize(size,size,{fit:'contain'}).png().toFile(dir+'/ic_launcher_round.png');
}
const foreground=[
'<?xml version="1.0" encoding="utf-8"?>',
'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">',
'<path android:fillColor="#FF55BA" android:strokeColor="#FFD8F6" android:strokeWidth="10" android:pathData="M256,88 A168,168 0,1 0,256 424 A168,168 0,1 0,256 88"/>',
'<path android:fillColor="#111026" android:pathData="M256,150 A106,106 0,1 0,256 362 A106,106 0,1 0,256 150"/>',
'<path android:fillColor="#FFFFFF" android:pathData="M207,192 C219,181 241,184 252,194 L243,210 C235,204 223,203 219,211 C214,220 248,221 254,238 C261,258 242,274 223,271 C210,270 200,264 193,256 L205,240 C214,249 227,255 235,247 C242,238 210,236 204,223 C199,212 200,200 207,192 Z"/>',
'<path android:fillColor="#FFFFFF" android:pathData="M270,196 L288,196 L288,242 C288,255 294,262 304,262 C315,262 321,254 321,241 L321,196 L339,196 L339,277 L322,277 L322,267 C315,275 306,280 295,279 C277,279 270,266 270,248 Z"/>',
'<path android:fillColor="#9C31FF" android:pathData="M126,365 L180,365 L180,405 L126,405 Z M190,337 L244,337 L244,405 L190,405 Z M254,309 L308,309 L308,405 L254,405 Z M318,281 L372,281 L372,405 L318,405 Z"/>',
'<path android:strokeColor="#43D9FF" android:strokeWidth="11" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="M115,350 C166,336 190,300 239,313 S313,273 385,232"/>
'</vector>'
].join('\n');
const monochrome=[
'<?xml version="1.0" encoding="utf-8"?>',
'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="512" android:viewportHeight="512">',
'<path android:fillColor="#FFFFFF" android:pathData="M256,88 A168,168 0,1 0,256 424 A168,168 0,1 0,256 88"/>',
'<path android:fillColor="#000000" android:pathData="M207,192 C219,181 241,184 252,194 L243,210 C235,204 223,203 219,211 C214,220 248,221 254,238 C261,258 242,274 223,271 C210,270 200,264 193,256 L205,240 C214,249 227,255 235,247 C242,238 210,236 204,223 C199,212 200,200 207,192 Z"/>',
'<path android:fillColor="#000000" android:pathData="M270,196 L288,196 L288,242 C288,255 294,262 304,262 C315,262 321,254 321,241 L321,196 L339,196 L339,277 L322,277 L322,267 C315,275 306,280 295,279 C277,279 270,266 270,248 Z"/>',
'</vector>'
].join('\n');
await writeFile(res+'/drawable/ic_launcher_foreground.xml',foreground,'utf8');
await writeFile(res+'/drawable/ic_launcher_monochrome.xml',monochrome,'utf8');
await writeFile(res+'/values/ic_launcher_background.xml','<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">#111026</color></resources>','utf8');
const adaptiveIcon='<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/ic_launcher_background"/><foreground android:drawable="@drawable/ic_launcher_foreground"/><monochrome android:drawable="@drawable/ic_launcher_monochrome"/></adaptive-icon>';
await writeFile(res+'/mipmap-anydpi-v26/ic_launcher.xml',adaptiveIcon,'utf8');
await writeFile(res+'/mipmap-anydpi-v26/ic_launcher_round.xml',adaptiveIcon,'utf8');
console.log('Generated density-specific launcher PNGs and adaptive/monochrome Android icons.');

const gradlePath='android/app/build.gradle';
let gradle=await readFile(gradlePath,'utf8');
gradle=gradle.replace(/versionCode\s+\d+/, 'versionCode 11002');
gradle=gradle.replace(/versionName\s+['"][^'"]*['"]/, 'versionName "1.10.2-beta"');
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


// Register a MediaStore-backed Capacitor plugin for public Downloads on Android 10+.
const mainActivityPath = 'android/app/src/main/java/com/osudailytracker/app/MainActivity.java';
let mainActivity = await readFile(mainActivityPath, 'utf8');
const packageMatch = mainActivity.match(/^package\s+([\w.]+);/m);
if (!packageMatch) throw new Error('Could not determine Android application package.');
const javaPackage = packageMatch[1];
const javaDir = 'android/app/src/main/java/' + javaPackage.replace(/\./g, '/');
await mkdir(javaDir, { recursive: true });
const pluginSource = `package ${javaPackage};

import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

@CapacitorPlugin(name = "NativeLogs")
public class NativeLogsPlugin extends Plugin {
    private static final String PREFS = "osu_daily_tracker_logs";
    private static final String URI_KEY = "active_log_uri";
    private static final String FOLDER = "Download/OsuDailyTracker/";

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Uri uri = getActiveUri();
            if (uri == null) uri = createLogFile();
            JSObject result = new JSObject();
            result.put("fileName", getDisplayName(uri));
            result.put("folder", "Downloads/OsuDailyTracker");
            call.resolve(result);
        } catch (Exception e) { call.reject("Не удалось создать файл логов в Downloads: " + e.getMessage(), e); }
    }

    @PluginMethod
    public void exportFile(PluginCall call) {
        Uri uri = null;
        try {
            if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("Для сохранения в Downloads требуется Android 10 или новее");
            String requested = call.getString("filename", "osu-daily-tracker-export.json");
            if (requested == null) requested = "osu-daily-tracker-export.json";
            String name = requested.replaceAll("[^A-Za-z0-9._-]", "_");
            if (name.isEmpty()) name = "osu-daily-tracker-export.json";
            if (!name.toLowerCase(Locale.ROOT).endsWith(".json")) name += ".json";
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("MediaStore не создал JSON-файл");
            String content = call.getString("content", "");
            if (content == null) content = "";
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "w")) {
                if (stream == null) throw new IllegalStateException("Android не открыл JSON-файл");
                stream.write(content.getBytes("UTF-8"));
                stream.flush();
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, ready, null, null);
            JSObject result = new JSObject();
            result.put("fileName", name);
            result.put("folder", "Downloads/OsuDailyTracker");
            call.resolve(result);
        } catch (Exception e) {
            if (uri != null) {
                try { getContext().getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
            }
            call.reject("Не удалось сохранить JSON в Downloads/OsuDailyTracker: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        String line = call.getString("line", "");
        if (line == null || line.isEmpty()) { call.resolve(); return; }
        try {
            Uri uri = getActiveUri();
            if (uri == null) uri = createLogFile();
            try {
                appendToUri(uri, line);
            } catch (Exception firstError) {
                // MediaStore URIs can become stale after cleanup, restore, or provider-side row removal.
                clearActiveUri();
                Uri replacement = createLogFile();
                try {
                    appendToUri(replacement, line);
                } catch (Exception retryError) {
                    retryError.addSuppressed(firstError);
                    throw retryError;
                }
            }
            call.resolve();
        } catch (Exception e) { call.reject("Не удалось записать лог в Downloads: " + e.getMessage(), e); }
    }

    private void appendToUri(Uri uri, String line) throws Exception {
        try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wa")) {
            if (stream == null) throw new IllegalStateException("Android не открыл файл логов: " + uri);
            stream.write(line.getBytes("UTF-8"));
            stream.flush();
        }
    }

    private void clearActiveUri() {
        getContext().getSharedPreferences(PREFS, 0).edit().remove(URI_KEY).apply();
    }

    private Uri getActiveUri() {
        String value = getContext().getSharedPreferences(PREFS, 0).getString(URI_KEY, null);
        if (value == null) return null;
        try {
            Uri uri = Uri.parse(value);
            try (Cursor cursor = getContext().getContentResolver().query(uri,
                    new String[]{MediaStore.MediaColumns._ID}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) return uri;
            }
        } catch (Exception ignored) { }
        clearActiveUri();
        return null;
    }

    private Uri createLogFile() throws Exception {
        if (Build.VERSION.SDK_INT < 29) throw new IllegalStateException("Для общей папки Downloads требуется Android 10 или новее");
        String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date());
        String name = "osu-daily-tracker-" + stamp + ".jsonl";
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/x-ndjson");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IllegalStateException("MediaStore не создал файл");
        ContentValues ready = new ContentValues();
        ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContext().getContentResolver().update(uri, ready, null, null);
        getContext().getSharedPreferences(PREFS, 0).edit().putString(URI_KEY, uri.toString()).apply();
        return uri;
    }

    private String getDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri,
                new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) { }
        return "osu-daily-tracker-log.jsonl";
    }
}
`;
await writeFile(javaDir + '/NativeLogsPlugin.java', pluginSource, 'utf8');
if (!mainActivity.includes('NativeLogsPlugin')) {
  mainActivity = mainActivity.replace('import com.getcapacitor.BridgeActivity;',
    'import com.getcapacitor.BridgeActivity;\nimport ' + javaPackage + '.NativeLogsPlugin;');
  mainActivity = mainActivity.replace('public class MainActivity extends BridgeActivity {',
    'public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(NativeLogsPlugin.class);\n        super.onCreate(savedInstanceState);\n    }');
  if (!mainActivity.includes('registerPlugin(NativeLogsPlugin.class)')) throw new Error('Could not register NativeLogsPlugin.');
  await writeFile(mainActivityPath, mainActivity, 'utf8');
}
console.log('Installed NativeLogsPlugin for Downloads/OsuDailyTracker.');
