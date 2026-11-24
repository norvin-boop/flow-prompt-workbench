import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const host = '127.0.0.1';
const scope = 'https://www.googleapis.com/auth/drive.file';
const folderType = 'application/vnd.google-apps.folder';
const drive = 'https://www.googleapis.com/drive/v3';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const limit = 512 * 1024 * 1024;
const chunkSize = 8 * 1024 * 1024;
const idPattern = /^[\w-]{1,160}$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireCondition(condition, status, message) {
  if (!condition) throw new RequestError(status, message);
}

async function readBody(request, max) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireCondition(length <= max, 413, 'The request exceeds the upload limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  try {
    return JSON.parse(await readBody(request, 4096));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'The Drive connection request is invalid.');
  }
}

function randomKey() {
  return randomBytes(32).toString('base64url');
}

export async function startDriveBridge({ client, extensionId, pairingKey = randomKey(), port = 7463, requestGoogle = fetch }) {
  requireCondition(/^[a-p]{32}$/.test(extensionId), 400, 'Use the Workbench extension ID shown in Settings.');
  requireCondition(typeof client?.client_id === 'string' && client.client_id.endsWith('.apps.googleusercontent.com')
    && typeof client.client_secret === 'string' && client.client_secret.length > 0, 400,
  'Provide the OAuth credentials JSON for a Google Cloud Desktop app.');
  const origin = 'chrome-extension://' + extensionId;
  const expectedKey = Buffer.from('Bearer ' + pairingKey);
  let pending = null;
  let connection = null;
  let connectionError = '';
  let base;
  const uploads = new Map();

  function response(out, code, data) {
    out.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    out.end(JSON.stringify(data));
  }

  function callbackPage(out, code, message) {
    out.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'"
    });
    out.end(message + '\n\nYou can close this tab and return to Workbench.');
  }

  async function google(url, options = {}) {
    try {
      return await requestGoogle(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(90000) });
    } catch {
      throw new RequestError(502, 'Could not reach Google. Check your network and try again when ready.');
    }
  }

  async function exchange(params) {
    const result = await google(tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params })
    });
    requireCondition(result.ok, 401, 'Google could not authorize this connection. Check the Desktop OAuth client and the selected Google account.');
    const data = await result.json();
    requireCondition(typeof data.access_token === 'string' && data.access_token.length > 0, 401, 'Google returned no access token.');
    if (data.scope) requireCondition(data.scope.split(/\s+/).every(value => value === scope), 403, 'The connection returned unexpected Google scopes.');
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + Number(data.expires_in || 3600) * 1000
    };
  }

  async function googleWithToken(token, url, options = {}) {
    const result = await google(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token.access } });
    if (result.status === 401) throw new RequestError(401, 'Google authorization expired or was revoked. Connect the account again.');
    return result;
  }

  function authorize(folder) {
    requireCondition(!folder || idPattern.test(folder), 400, 'The Drive folder ID is invalid.');
    requireCondition(!uploads.size, 409, 'Wait for the current upload before changing accounts.');
    const verifier = randomKey();
    const state = randomKey();
    pending = { state, verifier, folder, expires: Date.now() + 10 * 60 * 1000 };
    connectionError = '';
    const params = new URLSearchParams({
      client_id: client.client_id, redirect_uri: base + '/callback', response_type: 'code',
      scope, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      trigger_onepick: 'true', allow_folder_selection: 'true', mimetypes: folderType
    });
    if (folder) params.set('file_ids', folder);
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
  }

  async function confirmFolder(token, folder) {
    const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,mimeType,trashed,capabilities(canAddChildren)' });
    const result = await googleWithToken(token, drive + '/files/' + encodeURIComponent(folder) + '?' + params);
    requireCondition(result.ok, 403, 'Google cannot access this folder through the connected account. Reauthorize it in Settings.');
    const file = await result.json();
    requireCondition(file.id === folder && file.mimeType === folderType && !file.trashed && file.capabilities?.canAddChildren === true,
      403, 'The selected Google account does not have permission to upload to this folder.');
    return { id: file.id, name: file.name };
  }

  async function authorizeCallback(url, out) {
    const flow = pending;
    if (!flow || flow.callback || flow.expires < Date.now() || url.searchParams.get('state') !== flow.state) {
      callbackPage(out, 400, 'This Google authorization request expired or did not match Workbench.');
      return;
    }
    flow.callback = true;
    flow.expires = Date.now() + 2 * 60 * 1000;
    try {
      const code = url.searchParams.get('code');
      const picked = url.searchParams.get('picked_file_ids')?.split(',') || [];
      requireCondition(code && !url.searchParams.has('error'), 400, 'Google authorization was cancelled or denied.');
      requireCondition(picked.length === 1 && idPattern.test(picked[0]), 400, 'Select exactly one Drive folder in Google Picker.');
      requireCondition(!flow.folder || flow.folder === picked[0], 400, 'The selected Drive folder did not match the project’s upload link.');
      const token = await exchange({ code, code_verifier: flow.verifier, redirect_uri: base + '/callback', grant_type: 'authorization_code' });
      const [folder, accountResult] = await Promise.all([
        confirmFolder(token, picked[0]), googleWithToken(token, drive + '/about?fields=user(displayName,emailAddress)')
      ]);
      requireCondition(accountResult.ok, 403, 'Google did not confirm the connected Drive account.');
      const account = (await accountResult.json()).user;
      requireCondition(account?.emailAddress || account?.displayName, 403, 'Google did not disclose the selected account.');
      requireCondition(pending === flow, 409, 'A newer authorization request replaced this one.');
      connection = { token, folder, account };
      connectionError = '';
      callbackPage(out, 200, 'Google Drive is connected. Workbench can upload to the approved folder.');
    } catch (error) {
      if (pending === flow) connectionError = error instanceof RequestError ? error.message : 'Google authorization could not be completed.';
      callbackPage(out, 400, error instanceof RequestError ? error.message : 'Google authorization could not be completed.');
    } finally {
      if (pending === flow) pending = null;
    }
  }

  async function accessToken(current) {
    if (current.token.expires < Date.now() + 60000) {
      requireCondition(current.token.refresh, 401, 'Reconnect your Google account in Settings.');
      const fresh = await exchange({ refresh_token: current.token.refresh, grant_type: 'refresh_token' });
      current.token = { ...fresh, refresh: fresh.refresh || current.token.refresh };
    }
    return current.token;
  }

  async function initializeUpload(body) {
    const { name, size, folderId } = body ?? {};
    requireCondition(typeof name === 'string' && name.length <= 255 && /\.zip$/i.test(name)
      && !/[\/\\\x00-\x1f]/.test(name), 400, 'Select a valid ZIP filename.');
    requireCondition(Number.isSafeInteger(size) && size > 0 && size <= limit, 400, 'Send supports ZIPs up to 512 MB.');
    requireCondition(!pending && !uploads.size, 409, 'Finish the current connection or upload first.');
    const current = connection;
    requireCondition(current?.folder.id === folderId, 403, 'Authorize this exact Google Drive folder in Presets & Settings.');
    const id = randomKey();
    const upload = { current, folderId, name, size, offset: 0, expires: Date.now() + 30 * 60 * 1000 };
    uploads.set(id, upload);
    try {
      const token = await accessToken(current);
      await confirmFolder(token, folderId);
      const session = await googleWithToken(token,
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,parents,size,webViewLink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(size) },
          body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/zip' })
        });
      requireCondition(session.ok, 403, 'Google Drive rejected the upload request. Check the connected account and its folder access.');
      const location = new URL(session.headers.get('location') || base);
      requireCondition(location.origin === 'https://www.googleapis.com' && location.pathname === '/upload/drive/v3/files'
        && location.searchParams.has('upload_id'), 502, 'Google did not provide a valid resumable upload session.');
      upload.url = location.href;
      return { id };
    } catch (error) {
      uploads.delete(id);
      throw error;
    }
  }

  async function uploadChunk(request, id, offset) {
    const upload = uploads.get(id);
    requireCondition(upload?.url && upload.current === connection, 404, 'The upload session expired. Check Drive before sending again.');
    requireCondition(!upload.inFlight && offset === upload.offset, 409, 'The upload chunk is out of sequence.');
    const bytes = Math.min(chunkSize, upload.size - offset);
    upload.inFlight = true;
    try {
      const chunk = await readBody(request, bytes);
      requireCondition(chunk.length === bytes, 400, 'The ZIP data did not match the expected chunk length.');
      const token = await accessToken(upload.current);
      const result = await googleWithToken(token, upload.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes),
          'Content-Range': 'bytes ' + offset + '-' + (offset + bytes - 1) + '/' + upload.size },
        body: chunk
      });
      if (result.status === 308) {
        requireCondition(offset + bytes < upload.size && result.headers.get('range') === 'bytes=0-' + (offset + bytes - 1),
          502, 'Google did not acknowledge the full chunk. Check Drive before sending again.');
        upload.offset += bytes;
        return { state: 'uploading', received: upload.offset };
      }
      requireCondition(result.status === 200 || result.status === 201, 502, 'Google Drive stopped the upload. Check Drive before sending again.');
      const file = await result.json();
      requireCondition(offset + bytes === upload.size && idPattern.test(String(file.id || '')) && file.name === upload.name
        && Number(file.size) === upload.size && file.parents?.includes(upload.folderId), 502,
      'Google returned an incomplete upload receipt. Check the destination before sending again.');
      uploads.delete(id);
      return { state: 'uploaded', id: file.id, url: 'https://drive.google.com/file/d/' + file.id + '/view' };
    } catch (error) {
      uploads.delete(id);
      throw error;
    } finally {
      upload.inFlight = false;
    }
  }

  const server = createServer(async (request, out) => {
    if (request.headers.host !== new URL(base).host) return response(out, 403, { message: 'This helper only accepts local Workbench requests.' });
    const url = URL.parse(request.url, base);
    if (url?.origin !== base) return response(out, 400, { message: 'Invalid local Drive helper URL.' });
    if (request.method === 'GET' && url.pathname === '/callback') return authorizeCallback(url, out);
    if (request.headers.origin && request.headers.origin !== origin) return response(out, 403, { message: 'This browser extension is not paired.' });
    out.setHeader('Access-Control-Allow-Origin', origin);
    out.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      out.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Private-Network': 'true' });
      return out.end();
    }
    const bearer = Buffer.from(request.headers.authorization || '');
    if (bearer.length !== expectedKey.length || !timingSafeEqual(bearer, expectedKey)) {
      return response(out, 401, { message: 'Enter the current pairing code printed by the local Drive helper.' });
    }
    for (const [id, upload] of uploads) if (upload.expires < Date.now() && !upload.inFlight) uploads.delete(id);
    if (pending && pending.expires < Date.now()) {
      pending = null;
      connectionError = 'Google authorization timed out. Start again in Settings.';
    }
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        return response(out, 200, { account: connection?.account, folder: connection?.folder, pending: Boolean(pending), error: connectionError });
      }
      if (request.method === 'POST' && url.pathname === '/authorize') {
        const { folderId } = (await readJson(request)) ?? {};
        return response(out, 200, { url: authorize(folderId || '') });
      }
      if (request.method === 'POST' && url.pathname === '/disconnect') {
        requireCondition(!uploads.size, 409, 'Wait for the current ZIP upload to finish.');
        pending = connection = null;
        connectionError = '';
        return response(out, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/uploads') {
        return response(out, 201, await initializeUpload(await readJson(request)));
      }
      const route = url.pathname.match(/^\/uploads\/([\w-]+)$/);
      if (request.method === 'PUT' && route && /^\d+$/.test(url.searchParams.get('offset') || '')) {
        return response(out, 200, await uploadChunk(request, route[1], Number(url.searchParams.get('offset'))));
      }
      if (request.method === 'DELETE' && route) {
        if (!uploads.get(route[1])?.inFlight) uploads.delete(route[1]);
        return response(out, 200, { ok: true });
      }
      return response(out, 404, { message: 'Unknown Drive helper route.' });
    } catch (error) {
      return response(out, error.status || 500, { message: error instanceof RequestError ? error.message : 'The Drive helper could not complete the request.' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  base = 'http://' + host + ':' + server.address().port;
  return { server, base, pairingKey };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , credentialsPath, extensionId] = process.argv;
    if (!credentialsPath || !extensionId) throw new Error('Usage: node drive-bridge.mjs <Desktop OAuth JSON file> <Workbench extension ID>');
    const { installed } = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const bridge = await startDriveBridge({ client: installed, extensionId });
    console.log('Workbench Drive helper is listening at ' + bridge.base);
    console.log('Pairing code: ' + bridge.pairingKey);
    console.log('Enter this code in Workbench Settings. Leave this terminal open while using Drive.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

