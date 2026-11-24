export const driveBridgeHost = 'http://127.0.0.1/*';
export const driveUploadLimit = 512 * 1024 * 1024;
const bridgeUrl = 'http://127.0.0.1:7463';
const chunkSize = 8 * 1024 * 1024;

export function driveFolder(value) {
  try {
    const url = new URL(value.trim());
    if (url.origin !== 'https://drive.google.com' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)\/?$/);
    return match ? { id: match[1], url: url.href } : null;
  } catch {
    return null;
  }
}

export async function requestDriveBridge(pairingKey, path, options = {}) {
  let response;
  try {
    response = await fetch(bridgeUrl + path, {
      ...options,
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(100000),
      headers: { ...options.headers, Authorization: 'Bearer ' + pairingKey }
    });
  } catch {
    throw new Error('The local Drive helper did not respond. Start it and reconnect the account in Presets & Settings.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message || 'The local Drive helper returned an invalid response.');
  return result;
}

export async function uploadZip(folder, file, request, markDispatched, report) {
  report({ message: 'Checking your Google account and folder…' });
  const { id } = await request('/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, folderId: folder.id })
  });
  if (!/^[\w-]+$/.test(id || '')) throw new Error('The Drive helper did not start a valid upload session.');
  const path = '/uploads/' + id;
  try {
    await markDispatched();
    report({ message: 'Uploading to Google Drive…', percent: 0 });
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const bytes = file.slice(offset, offset + chunkSize);
      const ack = await request(path + '?offset=' + offset, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes
      });
      const received = offset + bytes.size;
      if (ack.state === 'uploaded' && received === file.size && /^[\w-]+$/.test(ack.id || '')) {
        return { state: 'uploaded', message: 'Google Drive confirmed the upload.', url: 'https://drive.google.com/file/d/' + ack.id + '/view' };
      }
      if (ack.state !== 'uploading' || received !== ack.received || received === file.size) {
        throw new Error('Google Drive did not confirm the upload. Check the destination before retrying.');
      }
      const percent = Math.floor(100 * received / file.size);
      report({ message: 'Uploading to Google Drive · ' + percent + '%', percent });
    }
    throw new Error('Google Drive did not confirm an uploaded file.');
  } finally {
    await request(path, { method: 'DELETE' }).catch(() => {});
  }
}

