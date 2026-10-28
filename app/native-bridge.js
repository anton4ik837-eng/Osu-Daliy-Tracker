import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

// Expose only the native bridge APIs needed by the static HTML frontend.
window.NativeApp = App;
window.NativeBrowser = Browser;
