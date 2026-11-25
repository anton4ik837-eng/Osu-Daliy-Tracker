// Optional local app lock. PIN hash is stored locally; the PIN itself never is.
(function () {
  const STORE_KEY = 'odt-pin-v1';
  const UNLOCK_KEY = 'odt-unlocked-v1';
  const encoder = new TextEncoder();

  const bytesToHex = bytes => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  async function hash(pin, salt) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(salt + ':' + pin));
    return bytesToHex(digest);
  }
  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
  }
  function writeStore(value) {
    try {
      if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORE_KEY);
    } catch { /* storage unavailable */ }
  }
  function isUnlocked() {
    try { return sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch { return false; }
  }

  function overlay() {
    let root = document.getElementById('odtPinOverlay');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'odtPinOverlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(5,9,16,.96);backdrop-filter:blur(8px)';
    root.innerHTML = '<div style="width:min(380px,100%);background:#141b28;border:1px solid #38536b;border-radius:18px;padding:22px;color:#fff7fc;font:15px/1.5 Inter,system-ui,sans-serif;box-shadow:0 24px 80px #000a">' +
      '<h2 id="odtPinTitle" style="margin:0 0 8px;font-size:22px">PIN-код приложения</h2>' +
      '<p id="odtPinHint" class="fine" style="color:#91a3b9;margin:0 0 14px"></p>' +
      '<input id="odtPinInput" type="password" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="От 4 до 12 цифр" style="width:100%;padding:11px 12px;border-radius:10px;border:1px solid #38536b;background:#0b0f17;color:#fff7fc;font:inherit">' +
      '<div id="odtPinStatus" style="min-height:20px;color:#ff9baf;font-size:13px;margin-top:8px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<button id="odtPinOk" type="button" style="padding:9px 14px;border:1px solid #57c9e8;border-radius:9px;background:#57c9e8;color:#0b0f17;font-weight:700;cursor:pointer">Подтвердить</button>' +
      '<button id="odtPinRemove" type="button" style="padding:9px 14px;border:1px solid #38536b;border-radius:9px;background:transparent;color:#a9e7ff;cursor:pointer">Удалить PIN</button>' +
      '<button id="odtPinCancel" type="button" style="padding:9px 14px;border:1px solid #38536b;border-radius:9px;background:transparent;color:#a9e7ff;cursor:pointer">Отмена</button>' +
      '</div></div>';
    document.body.appendChild(root);
    return root;
  }

  function show(options) {
    const root = overlay();
    const title = root.querySelector('#odtPinTitle');
    const hint = root.querySelector('#odtPinHint');
    const input = root.querySelector('#odtPinInput');
    const status = root.querySelector('#odtPinStatus');
    const ok = root.querySelector('#odtPinOk');
    const remove = root.querySelector('#odtPinRemove');
    const cancel = root.querySelector('#odtPinCancel');
    const mode = options.mode || 'unlock';
    title.textContent = mode === 'set' ? 'Установить PIN-код' : 'Вход по PIN-коду';
    hint.textContent = mode === 'set' ? ' PIN защищает приложение на этом устройстве. Он не отправляется на сервер.' : 'Введи PIN, чтобы открыть приложение.';
    status.textContent = '';
    input.value = '';
    ok.textContent = mode === 'set' ? 'Сохранить' : 'Подтвердить';
    remove.style.display = mode === 'set' && readStore() ? '' : 'none';
    cancel.style.display = mode === 'set' ? '' : 'none';
    root.style.display = 'flex';
    setTimeout(() => input.focus(), 50);

    function close() { root.style.display = 'none'; }
    ok.onclick = async () => {
      const pin = input.value.trim();
      if (!/^\d{4,12}$/.test(pin)) { status.textContent = 'Нужно от 4 до 12 цифр.'; return; }
      if (mode === 'set') {
        const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        writeStore({ salt, hash: await hash(pin, salt) });
        try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch {}
        close();
        if (options.onDone) options.onDone('PIN-код установлен.');
      } else {
        const store = readStore();
        if (!store || await hash(pin, store.salt) !== store.hash) { status.textContent = 'Неверный PIN-код.'; return; }
        try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch {}
        close();
        if (options.onDone) options.onDone('');
      }
    };
    remove.onclick = () => { writeStore(null); close(); if (options.onDone) options.onDone('PIN-код удалён.'); };
    cancel.onclick = close;
    input.onkeydown = event => { if (event.key === 'Enter') ok.click(); };
  }

  window.ODTSecurity = {
    hasPin: () => Boolean(readStore()),
    lock: () => { try { sessionStorage.removeItem(UNLOCK_KEY); } catch {} show({ mode: 'unlock' }); },
    openSettings: (onDone) => show({ mode: 'set', onDone }),
  };

  function clearUnlock() {
    try { sessionStorage.removeItem(UNLOCK_KEY); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearUnlock(); });
  window.addEventListener('pagehide', clearUnlock);
  window.addEventListener('beforeunload', clearUnlock);
  try {
    window.NativeApp?.addListener?.('appStateChange', ({ isActive }) => { if (!isActive) clearUnlock(); });
  } catch { /* native bridge is optional */ }

  if (readStore() && !isUnlocked()) show({ mode: 'unlock' });
})();
