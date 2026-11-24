export const driveHost = 'https://drive.google.com/*';
export const driveUploadLimit = 512 * 1024 * 1024;

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

async function waitForPage(tabId) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Drive did not load. Open the folder and check your sign-in.');
}

function base64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  const blocks = [];
  for (let index = 0; index < bytes.length; index += 0x4000) {
    blocks.push(String.fromCharCode(...bytes.subarray(index, index + 0x4000)));
  }
  return btoa(blocks.join(''));
}

export async function openDriveUploadInput(folderId, attempt) {
  // Runs briefly in Drive's page world so a detached native file input can use the same upload handler.
  const inFolder = () => location.origin === 'https://drive.google.com'
    && location.pathname.match(/^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)\/?$/)?.[1] === folderId;
  const named = (selector, name) => [...document.querySelectorAll(selector)].filter(element => {
    const labels = [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText,
      ...[...element.querySelectorAll('span')].map(span => span.innerText)];
    return element.getClientRects().length && !element.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],:disabled')
      && labels.some(value => value && name.test(value.replace(/\s+/g, ' ').trim()));
  });
  const buttons = 'button,[role="button"]';
  const chooseUpload = () => named('[role="menuitem"],button,[role="button"]', /^file upload(?: (?:alt|ctrl|shift|⌘).*|)$/i);
  if (!inFolder()) return { message: 'Drive changed folders before opening File upload.' };
  const create = named(buttons, /^new(?: folder menu)?$/i);
  if (chooseUpload().length === 0 && create.length === 1) create[0].click();
  let upload;
  for (let check = 0; check < 12 && inFolder(); check++) {
    const options = chooseUpload();
    if (options.length === 1) {
      [upload] = options;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!upload || !inFolder()) return { message: 'Drive’s File upload command is unavailable. Check the folder account and permissions.' };

  const prototype = HTMLInputElement.prototype;
  const nativeClick = prototype.click;
  const nativePicker = prototype.showPicker;
  let input;
  const capture = element => {
    if (element.type !== 'file' || element.hasAttribute('webkitdirectory') || !inFolder()) return false;
    input ??= element;
    return true;
  };
  const captureClick = event => {
    if (event.target instanceof HTMLInputElement && capture(event.target)) event.preventDefault();
  };
  try {
    prototype.click = function (...args) {
      if (!capture(this)) return nativeClick.apply(this, args);
    };
    if (nativePicker) prototype.showPicker = function (...args) {
      if (!capture(this)) return nativePicker.apply(this, args);
    };
    document.addEventListener('click', captureClick, true);
    upload.click();
    for (let check = 0; check < 8 && !input && inFolder(); check++) {
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  } finally {
    prototype.click = nativeClick;
    if (nativePicker) prototype.showPicker = nativePicker;
    document.removeEventListener('click', captureClick, true);
  }
  if (!input || !inFolder()) return { message: 'Drive did not expose its file input. Use Download ZIP and Open folder to upload manually.' };
  if (!input.isConnected) {
    input.hidden = true;
    input.dataset.flowWorkbenchTemporary = 'true';
    document.body.append(input);
  }
  input.dataset.flowWorkbenchUpload = attempt;
  return { ok: true };
}

export async function uploadZip(folder, file, markDispatched, report) {
  const tab = await chrome.tabs.create({ url: folder.url, active: false });
  const attempt = crypto.randomUUID();
  const send = (type, fields = {}) => chrome.tabs.sendMessage(tab.id, { type, attempt, folderId: folder.id, ...fields });
  report({ message: 'Opening the selected Drive folder…', tabId: tab.id, folder: folder.url });
  await waitForPage(tab.id);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['drive-upload.js'] });
  let prepared;
  for (let pass = 0; pass < 20; pass++) {
    prepared = await send('drive:prepare', { name: file.name, size: file.size });
    if (!prepared?.loading) break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  if (!prepared?.ok) throw new Error(prepared?.message || 'Drive’s upload area could not be verified. Use Open folder to upload manually.');

  try {
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      const reply = await send('drive:chunk', { offset, bytes: base64(bytes) });
      if (!reply?.ok) throw new Error('The Drive tab changed before upload. No ZIP was sent.');
      const percent = Math.floor((offset + bytes.length) / file.size * 100);
      report({ message: 'Preparing ZIP · ' + percent + '%', percent: Math.min(99, percent) });
    }

    const [input] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: openDriveUploadInput, args: [folder.id, attempt]
    });
    if (!input?.result?.ok) throw new Error(input?.result?.message || 'The Drive file input could not be prepared.');
    // Persist this before dispatch so reopening the sidebar cannot replay an unconfirmed upload.
    await markDispatched();
    const submission = await send('drive:submit');
    if (!submission?.ok) return { state: submission?.sent === false ? 'failed' : 'check', message: submission?.message || 'Drive did not acknowledge the upload request. Check the destination before retrying.' };
    report({ message: 'Uploading in Google Drive…' });

    const deadline = Date.now() + 15 * 60 * 1000;
    let lastActivity = Date.now();
    while (Date.now() < deadline && Date.now() - lastActivity < 90000) {
      const result = await send('drive:result');
      if (result?.state !== 'pending') return result || { state: 'check', message: 'Check the Drive folder for this ZIP.' };
      if (result.active) lastActivity = Date.now();
      if (Number.isFinite(result.percent)) {
        const percent = Math.min(99, Math.floor(result.percent));
        report({ message: 'Uploading in Google Drive · ' + percent + '%', percent });
      }
      await new Promise(resolve => setTimeout(resolve, 1750));
    }
    return { state: 'check', message: 'Drive has not confirmed the upload. Check its upload panel before sending again.' };
  } finally {
    await send('drive:release').catch(() => {});
  }
}

