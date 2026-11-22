// Desktop replacement for the Capacitor native bridge.
// The web pages call these APIs through optional chaining, so keeping the same
// names lets the desktop build reuse app/www without any Android-specific code.
(function () {
  const invoke = (method, ...args) => {
    try {
      return Promise.resolve(window.DesktopBridge?.[method]?.(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  window.IsDesktopApp = true;

  window.NativeLogs = {
    append: ({ line } = {}) => invoke('appendLog', line),
    start: () => invoke('startLog'),
    exportFile: options => invoke('exportLog', options)
  };

  window.NativeBrowser = {
    open: ({ url } = {}) => invoke('openExternal', url)
  };

  let lastOAuthUrl = null;
  const oauthCallbacks = [];
  const deliverOAuthUrl = url => {
    if (!url || url === lastOAuthUrl) return;
    lastOAuthUrl = url;
    oauthCallbacks.forEach(callback => {
      try { callback(url); } catch (error) { console.error('OAuth callback failed:', error); }
    });
  };

  window.DesktopBridge?.onOAuthCallback?.(deliverOAuthUrl);
  invoke('getLaunchUrl').then(deliverOAuthUrl).catch(() => {});

  window.NativeApp = {
    addListener: (event, callback) => {
      if (event === 'appUrlOpen' && typeof callback === 'function') oauthCallbacks.push(callback);
      return Promise.resolve();
    },
    removeAllListeners: () => Promise.resolve(),
    getLaunchUrl: () => invoke('getLaunchUrl')
  };

  window.NativeFilesystem = {};
  window.NativeFilesystemDirectory = {};
  window.NativeShare = {};

  document.addEventListener('click', event => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    const url = link.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url)) return;
    event.preventDefault();
    invoke('openExternal', url);
  }, true);
})();
