(() => {
  if (globalThis.flowWorkbenchDriveUpload) return;
  globalThis.flowWorkbenchDriveUpload = true;
  let pending = null;
  let timer;
  const maxSize = 512 * 1024 * 1024;

  function folderMatches(id) {
    const match = location.pathname.match(/^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)\/?$/);
    return location.origin === 'https://drive.google.com' && match?.[1] === id;
  }

  function visible(element) {
    return element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
  }

  function visibleDialog() {
    return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].find(visible);
  }

  function fileRow(main, name) {
    const labels = main.querySelectorAll('[role="row"],[role="gridcell"],[role="listitem"],[data-tooltip],[aria-label]');
    return [...labels].find(element => visible(element) && (
      element.getAttribute('data-tooltip') === name ||
      element.getAttribute('aria-label') === name ||
      element.textContent.trim() === name
    ));
  }

  function uploadProgress() {
    for (const bar of document.querySelectorAll('progress,[role="progressbar"]')) {
      if (!visible(bar)) continue;
      let scope = bar;
      for (let parent = 0; parent < 5 && scope && scope !== document.body; parent++, scope = scope.parentElement) {
        const value = [scope.innerText, scope.getAttribute('aria-label'), scope.getAttribute('title')].filter(Boolean).join(' ');
        if (!value.includes(pending.name)) continue;
        const current = bar.getAttribute('aria-valuenow') ?? bar.getAttribute('value');
        const max = Number(bar.getAttribute('aria-valuemax') ?? bar.getAttribute('max') ?? 100);
        const match = value.match(/\b(\d{1,3})\s*%/);
        const percent = current !== null && max > 0 ? 100 * Number(current) / max : Number(match?.[1]);
        return { state: 'pending', active: true, ...(Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, percent)) } : {}) };
      }
    }
    return null;
  }

  function result() {
    const messages = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
      .filter(visible).map(element => element.innerText.trim()).filter(Boolean);
    const fresh = messages.filter(message => !pending.before.has(message));
    const failed = fresh.find(message => /upload failed|could(?:n.t| not) upload|upload error|storage (?:is )?full|permission denied/i.test(message));
    if (failed) return { state: 'failed', message: failed.slice(0, 240) };
    if (fresh.some(message => message.includes(pending.name) && /upload(?:ed| (?:complete|finished|successful))/i.test(message))) {
      return { state: 'uploaded', message: 'Drive confirmed the upload.' };
    }
    const main = document.querySelector('main,[role="main"]');
    if (main && fileRow(main, pending.name)) return { state: 'uploaded', message: 'The ZIP is visible in the destination folder.' };
    const progress = uploadProgress();
    if (progress) return progress;
    if (visibleDialog()) return { state: 'check', message: 'Drive needs your attention. Open the upload tab to check the dialog.' };
    if (fresh.some(message => message.includes(pending.name) && /uploading/i.test(message))) {
      return { state: 'pending', active: true };
    }
    return { state: 'pending' };
  }

  function fileInput() {
    return [...document.querySelectorAll('input[type="file"][data-flow-workbench-upload]')]
      .find(input => input.dataset.flowWorkbenchUpload === pending?.id);
  }

  function release() {
    clearTimeout(timer);
    const input = fileInput();
    if (input?.dataset.flowWorkbenchTemporary === 'true') input.remove();
    else if (input) delete input.dataset.flowWorkbenchUpload;
    pending = null;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message.type?.startsWith('drive:')) return;
    if (!folderMatches(message.folderId)) return respond({ state: 'check', sent: false, message: 'The Drive tab is no longer on the selected folder.' });

    if (message.type === 'drive:prepare') {
      const main = document.querySelector('main,[role="main"]');
      if (visibleDialog()) return respond({ message: 'Close the open Drive dialog before sending a ZIP.' });
      if (!main || !visible(main) || main.matches('[aria-busy="true"]')) return respond({ loading: true });
      if (pending) return respond({ message: 'This Drive tab already has a delivery in progress.' });
      if (typeof message.name !== 'string' || !/\.zip$/i.test(message.name) ||
          !Number.isSafeInteger(message.size) || message.size <= 0 || message.size > maxSize) {
        return respond({ message: 'Drive Send accepts one ZIP up to 512 MB.' });
      }
      if (fileRow(main, message.name)) return respond({ message: 'A file with that name is already in the Drive folder.' });
      pending = { id: message.attempt, name: message.name, size: message.size, offset: 0, parts: [], sent: false };
      timer = setTimeout(release, 300000);
      return respond({ ok: true });
    }

    if (pending?.id !== message.attempt) return respond({ state: 'check', sent: false, message: 'Drive lost the upload session. Check the destination folder.' });
    if (message.type === 'drive:release') {
      release();
      return respond({ ok: true });
    }
    if (message.type === 'drive:chunk') {
      if (pending.sent || message.offset !== pending.offset || typeof message.bytes !== 'string' || message.bytes.length > 5592410) return respond({ ok: false });
      try {
        const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(message.bytes) : Uint8Array.from(atob(message.bytes), char => char.charCodeAt(0));
        if (pending.offset + bytes.length > pending.size) return respond({ ok: false });
        pending.parts.push(bytes);
        pending.offset += bytes.length;
        return respond({ ok: true });
      } catch {
        return respond({ ok: false });
      }
    }
    if (message.type === 'drive:result') {
      return respond(pending.sent ? result() : { state: 'check', message: 'The ZIP was not sent.' });
    }
    if (message.type !== 'drive:submit') return;
    if (pending.sent) return respond({ message: 'This ZIP already attempted to upload. Check Drive.' });

    const main = document.querySelector('main,[role="main"]');
    const input = fileInput();
    if (!input || input.disabled || !main || !visible(main) || main.matches('[aria-busy="true"]') || visibleDialog()
        || fileRow(main, pending.name) || pending.offset !== pending.size || input.files.length) {
      return respond({ sent: false, message: 'Drive changed or the file already exists. No ZIP was sent.' });
    }
    try {
      const payload = new DataTransfer();
      payload.items.add(new File(pending.parts, pending.name, { type: 'application/zip' }));
      input.files = payload.files;
      if (input.files.length !== 1 || input.files[0].name !== pending.name || input.files[0].size !== pending.size) {
        return respond({ sent: false, message: 'Drive’s file input did not accept the selected ZIP.' });
      }
      pending.parts = [];
      pending.before = new Set([...document.querySelectorAll('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]')]
        .map(element => element.innerText.trim()));
      pending.sent = true;
      clearTimeout(timer);
      timer = setTimeout(release, 20 * 60 * 1000);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      respond({ ok: true });
    } catch {
      respond({ sent: pending.sent, message: 'Drive could not accept this ZIP through its upload area. Check the folder before uploading manually.' });
    }
  });
})();

