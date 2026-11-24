import { driveBridgeHost, driveFolder, requestDriveBridge } from './drive.js';

const keyName = 'workbench-drive-pairing';

export function setupDriveAccount({ $, on, status, getFolder }) {
  let pairingKey = '';
  let connected = null;
  let busy = false;
  let polling = false;
  const listeners = new Set();

  function notify(message) {
    const account = connected?.account;
    $('drive-account-status').textContent = message || connected?.error || (connected?.pending ? 'Waiting for Google authorization…'
      : account ? 'Connected as ' + (account.emailAddress || account.displayName)
      : 'Google Drive is disconnected.');
    $('drive-authorized-folder').textContent = connected?.folder ? 'Approved folder · ' + connected.folder.name : '';
    $('drive-disconnect').disabled = busy || !pairingKey;
    $('drive-connect').disabled = busy;
    for (const listener of listeners) listener();
  }

  async function refresh() {
    if (!pairingKey || busy || polling) return;
    polling = true;
    const key = pairingKey;
    try {
      const details = await requestDriveBridge(key, '/status');
      if (pairingKey !== key) return;
      connected = details;
      notify();
    } catch (error) {
      if (pairingKey === key) {
        connected = null;
        notify(error.message);
      }
    } finally {
      polling = false;
    }
  }

  on('copy-extension-id', 'click', async () => {
    await navigator.clipboard.writeText(chrome.runtime.id);
    status('Extension ID copied.');
  });

  on('drive-connect', 'click', async () => {
    if (busy) return;
    const entered = $('drive-pairing-key').value.trim();
    const candidate = entered || pairingKey;
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) throw new Error('Enter the pairing code from the local Drive helper.');
    busy = true;
    const folder = driveFolder(getFolder());
    notify('Opening Google authorization…');
    try {
      const granted = await chrome.permissions.request({ origins: [driveBridgeHost] });
      if (!granted) throw new Error('Allow the extension to connect to the local Drive helper first.');
      const result = await requestDriveBridge(candidate, '/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: folder?.id || '' })
      });
      const url = new URL(result.url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') {
        throw new Error('The Drive helper returned an invalid Google sign-in URL.');
      }
      await chrome.storage.session.set({ [keyName]: candidate });
      pairingKey = candidate;
      connected = { pending: true };
      $('drive-pairing-key').value = '';
      await chrome.tabs.create({ url: url.href });
      status('Select your Google account and approve the destination folder.');
    } finally {
      busy = false;
      notify();
    }
  });

  on('drive-disconnect', 'click', async () => {
    if (pairingKey) await requestDriveBridge(pairingKey, '/disconnect', { method: 'POST' });
    await chrome.storage.session.remove(keyName);
    pairingKey = '';
    connected = null;
    notify();
  });

  chrome.storage.session.get(keyName).then(saved => {
    pairingKey = saved[keyName] || '';
    notify();
    if (pairingKey) return refresh();
  }).catch(error => status(error.message, true));
  setInterval(refresh, 4000);

  return {
    canUpload(folder) {
      return Boolean(pairingKey && connected?.account && !connected.pending && folder && folder.id === connected.folder?.id);
    },
    observe(listener) { listeners.add(listener); },
    async request(path, options) {
      const key = pairingKey;
      if (!key) throw new Error('Connect Google Drive in Presets & Settings first.');
      return requestDriveBridge(key, path, options);
    }
  };
}

