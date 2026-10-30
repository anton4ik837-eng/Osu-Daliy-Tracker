import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { registerPlugin } from '@capacitor/core';

// Expose only the native bridge APIs needed by the static HTML frontend.
window.NativeApp = App;
window.NativeBrowser = Browser;
window.NativeFilesystem = Filesystem;
window.NativeFilesystemDirectory = Directory;
window.NativeShare = Share;

// Public Downloads log writer (Android MediaStore).
window.NativeLogs = registerPlugin('NativeLogs');
const writeNativeDiagnostic = (event, details) => window.NativeLogs.append({ line: JSON.stringify({ time: new Date().toISOString(), event, details }) + '\\n' }).catch(() => {});
window.addEventListener('error', event => writeNativeDiagnostic('js.error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno }));
window.addEventListener('unhandledrejection', event => writeNativeDiagnostic('js.unhandled_rejection', { reason: String(event.reason?.message || event.reason || 'unknown') }));
