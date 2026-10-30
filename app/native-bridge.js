import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// Expose only the native bridge APIs needed by the static HTML frontend.
window.NativeApp = App;
window.NativeBrowser = Browser;
window.NativeFilesystem = Filesystem;
window.NativeFilesystemDirectory = Directory;
window.NativeShare = Share;
