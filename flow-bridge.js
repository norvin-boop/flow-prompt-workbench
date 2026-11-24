(() => {
  const editorSelector = 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],input[type="text"]';
  const controlSelector = 'button,[role="button"]';
  const sendLabel = /^(start generation|send(?: message| prompt)?)$/i;
  const ingredientLabel = /^(add (?:ingredients?(?: to the prompt box)?|images?|media|references?)|attach (?:media|images?))$/i;
  const uploadProblem = /(?:upload (?:failed|error)|failed to upload|could(?:n.t| not) upload|unsupported (?:file|image)|file too large)/i;
  const problem = /(?:too many requests|rate.?limit|quota (?:exceeded|reached)|out of (?:credits|generations)|not enough credits|generation (?:failed|error)|failed to (?:generate|submit)|could(?:n.t| not) generate|something went wrong|try again later|content (?:policy|violation)|violat(?:es|ion)|sign in to continue|service unavailable)/i;
  let linked = null;
  let pendingPick = null;
  let pickIssue = '';
  let sending = false;
  let activity = null;
  const usedReviews = new Set();

  function project() {
    const match = location.pathname.match(/(?:^|\/)project\/([a-z0-9_-]+)(?:\/|$)/i);
    return match && match[1] !== 'new' ? match[1] : null;
  }

  function visible(element) {
    return element.getClientRects().length > 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]')
      && getComputedStyle(element).visibility === 'visible';
  }

  function enabled(element) {
    return !element.matches(':disabled,[readonly],[aria-disabled="true"],[aria-readonly="true"]');
  }

  function editors(root) {
    return [...root.querySelectorAll(editorSelector)].filter(element =>
      visible(element) && enabled(element) && !element.parentElement?.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')
    );
  }

  function label(element) {
    const labels = (element.getAttribute('aria-labelledby') || '').split(/\s+/);
    return [
      element.getAttribute('aria-label'),
      ...labels.map(id => id && document.getElementById(id)?.textContent),
      element.getAttribute('title'),
      element.getAttribute('placeholder'),
      element.getAttribute('data-placeholder'),
      ...[...(element.labels || [])].map(item => item.textContent),
      element.querySelector('[data-slate-placeholder]')?.textContent,
      element.matches(controlSelector) ? element.textContent : ''
    ].filter(Boolean).join(' ').trim();
  }

  function isControl(control, pattern) {
    return [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent?.trim(), label(control)]
      .some(text => text && pattern.test(text.trim()));
  }

  function controls(root, pattern) {
    return [...root.querySelectorAll(controlSelector)].filter(control => visible(control) && isControl(control, pattern));
  }

  function agentRegion(editor) {
    for (let region = editor.parentElement; region && region !== document.body; region = region.parentElement) {
      if (controls(region, /^agent settings$/i).length && controls(region, /^(open )?session history$/i).length) {
        // Avoid walking into the whole app and mistaking its standard composer for the Agent.
        return editors(region).length === 1 ? region : null;
      }
    }
    return null;
  }

  function composerControl(editor, pattern, limit = null) {
    for (let region = editor.parentElement; region && region !== document.body; region = region.parentElement) {
      const found = controls(region, pattern);
      if (found.length) return editors(region).length === 1 && found.length === 1 ? found[0] : null;
      if (region === limit) break;
    }
    return null;
  }

  function findEditor(key) {
    const candidates = editors(document);
    if (linked?.key === key && candidates.includes(linked.element)) return linked.element;
    const agent = candidates.filter(element =>
      /\b(ask (?:the |flow )?agent|message (?:the |flow )?agent|agent prompt)\b/i.test(label(element))
      || agentRegion(element)
      || /^(?:google flow |flow )?agent(?: chat| panel| composer)?$/i.test(label(element.closest('form,[role="region"],[role="dialog"],aside,section') ?? element))
    );
    return agent.length === 1 ? agent[0] : null;
  }

  function read(element) {
    return 'value' in element ? element.value : element.innerText;
  }

  function normalize(text, element) {
    const value = text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
    return 'value' in element ? value : value.replace(/\n+/g, '\n');
  }

  function insert(element, text, protectExisting = false, keepAttachments = false) {
    const existing = normalize(read(element), element);
    const expected = normalize(text, element);
    if (!protectExisting && existing === expected) return { ok: true, message: 'This prompt is already in Flow.' };
    if (existing) return { message: 'The Flow composer has a draft. Clear it or use Copy Prompt.' };
    element.focus();
    if (document.activeElement !== element && !element.contains(document.activeElement)) {
      return { message: 'Flow’s composer could not be focused. Use Copy Prompt.' };
    }
    if ('setSelectionRange' in element) {
      element.setSelectionRange(0, element.value.length);
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      if (keepAttachments) range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('insertText', false, text);
    if (normalize(read(element), element) !== expected) {
      return { message: 'Flow did not accept the full prompt. Check the composer or use Copy Prompt.' };
    }
    return { ok: true, message: 'Prompt inserted. Review it and send it in Flow.' };
  }

  function flowProblem(editor, extra) {
    const region = editor && agentRegion(editor);
    const urgent = [...document.querySelectorAll('[role="alert"],[role="alertdialog"],[aria-live="assertive"]')];
    const status = region ? [...region.querySelectorAll('[role="status"],[aria-live="polite"]')] : [];
    const warning = [...urgent, ...status].find(element => {
      const text = element.innerText || '';
      return visible(element) && (problem.test(text) || extra?.test(text));
    });
    return warning ? warning.innerText.trim().slice(0, 240) : '';
  }

  function isBusy(editor) {
    const region = agentRegion(editor) || editor.closest('form');
    return region && (region.matches('[aria-busy="true"]')
      || [...region.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible)
      || controls(region, /^(stop (?:generation|generating|response)|cancel generation)$/i).length > 0);
  }

  function activityFor(key, editor, busy) {
    if (activity?.key !== key) return null;
    if (busy) activity.started = true;
    if (activity.started && !busy && editor && !read(editor).trim()) activity.finished = true;
    return { action: activity.action, started: activity.started, finished: activity.finished };
  }

  function projectPreview(editor) {
    const main = document.querySelector('#main-content,main');
    if (!main) return '';
    const agent = editor && agentRegion(editor);
    for (const item of main.querySelectorAll('img[src],video[poster]')) {
      if (agent?.contains(item) || item.closest('header,nav,[role="dialog"]') || !visible(item)) continue;
      const { width, height } = item.getBoundingClientRect();
      if (width < 85 || height < 65) continue;
      const url = item instanceof HTMLVideoElement ? item.poster : item.currentSrc || item.src;
      if (url?.startsWith('https://')) return url;
    }
    return '';
  }

  function projectAccount() {
    const pattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
    const button = controls(document, /^(?:account details|google account\b.*)$/i)[0];
    if (!button) return '';
    const avatar = button.querySelector('img');
    const title = [label(button), button.getAttribute('data-tooltip'), avatar?.alt, avatar?.title].filter(Boolean).join(' ');
    return title.match(pattern)?.[0] || '';
  }

  document.addEventListener('click', event => {
    if (!event.isTrusted || !activity || activity.started || activity.key !== project()) return;
    const control = event.target instanceof Element && event.target.closest(controlSelector);
    if (!control || !isControl(control, sendLabel) || !enabled(control)) return;
    const editor = findEditor(activity.key);
    if (editor && composerControl(editor, sendLabel, agentRegion(editor)) === control
        && normalize(read(editor), editor) === activity.draft) {
      activity.started = true;
    }
  }, true);

  function chooseEditor(key) {
    pendingPick?.cancel();
    pickIssue = '';
    const events = ['pointerdown', 'focusin', 'click'];
    const pick = event => {
      if (!event.isTrusted || project() !== key) return;
      const element = event.composedPath().find(node => node instanceof Element && node.matches(editorSelector));
      if (!element || !visible(element) || !enabled(element)) return;
      if (element.matches('input[type="text"]') && !agentRegion(element)
          || /^(search|editable text|project (?:name|title))\b/i.test(label(element))) {
        pickIssue = 'Click the prompt field inside Flow Agent.';
        return;
      }
      linked = { element, key };
      pendingPick.cancel();
    };
    const timer = setTimeout(() => {
      pendingPick?.cancel();
      pickIssue = 'Linking expired. Open Agent and try again.';
    }, 30000);
    pendingPick = {
      key,
      cancel() {
        clearTimeout(timer);
        for (const type of events) document.removeEventListener(type, pick, true);
        pendingPick = null;
      }
    };
    for (const type of events) document.addEventListener(type, pick, true);
  }

  function composerTray(editor) {
    const region = agentRegion(editor);
    if (!region) return null;
    for (let scope = editor.parentElement; scope; scope = scope.parentElement) {
      if (controls(scope, sendLabel).length === 1 && controls(scope, ingredientLabel).length === 1) return scope;
      if (scope === region) break;
    }
    return null;
  }

  function referenceFile(reference) {
    if (typeof reference?.name !== 'string' || reference.name.length > 85 || typeof reference.data !== 'string'
        || reference.data.length > 28_000_100) return null;
    const match = reference.data.match(/^data:(image\/(?:png|jpeg|webp|avif));base64,([A-Za-z0-9+/]+=*)$/);
    if (!match) return null;
    const [, type, base64] = match;
    const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(base64) : Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) return null;
    return new File([bytes], reference.name, { type });
  }

  function attachments(scope, filename) {
    const identify = value => String(value || '').toLowerCase();
    const name = identify(filename);
    const tokens = new Map();
    for (const image of scope.querySelectorAll('img')) {
      if (!visible(image)) continue;
      const card = image.closest('[data-testid*="attachment"],[data-testid*="ingredient"],[data-testid*="reference"]');
      const ingredient = image.closest(controlSelector);
      const remove = [image.parentElement, image.parentElement?.parentElement].find(parent =>
        parent && parent !== scope && controls(parent, /^(?:remove|delete|clear)(?:\b|$)/i).length === 1);
      const labelled = [image.alt, image.title, image.getAttribute('aria-label'), image.getAttribute('data-filename'),
        card?.getAttribute('aria-label'), card?.getAttribute('title')].some(value => identify(value).includes(name));
      if (card || remove || labelled || (ingredient && isControl(ingredient, /^ingredient(?: image)?$/i))) {
        const src = image.currentSrc || image.src;
        if (!src) continue;
        const token = labelled ? 'name:' + name : 'image:' + src;
        const file = tokens.get(token) || { count: 0, ready: false };
        file.count++;
        file.ready ||= image.complete && image.naturalWidth > 0;
        tokens.set(token, file);
      }
    }
    // Some Flow builds render an accessible file chip without an img element.
    if (!tokens.has('name:' + name)) {
      for (const control of controls(scope, /^(?:remove|delete|clear)(?:\b|$)/i)) {
        if (identify(label(control)).includes(name) && !control.parentElement?.querySelector('img')) {
          tokens.set('name:' + name, { count: 1, ready: true });
        }
      }
    }
    return tokens;
  }

  function uploadInProgress(scope) {
    return [...scope.querySelectorAll('[role="progressbar"],[aria-busy="true"],[role="status"],[aria-live]')].some(element =>
      visible(element) && (element.matches('[role="progressbar"],[aria-busy="true"]') || /\buploading\b/i.test(element.innerText || '')));
  }

  function assetPicker() {
    const lists = [...document.querySelectorAll('[aria-label="Asset list"],[aria-labelledby]')]
      .filter(element => visible(element) && /^asset list$/i.test(label(element)));
    if (lists.length !== 1) return null;
    const [list] = lists;
    for (let scope = list.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
      const search = [...scope.querySelectorAll('input,[role="searchbox"]')]
        .find(element => visible(element) && /^(?:search assets\s*)+$/i.test(label(element)));
      const confirm = controls(scope, /^add to prompt$/i);
      if (search && confirm.length === 1) return { list, search, confirm: confirm[0] };
    }
    return null;
  }

  function pickerOptions(list, filename) {
    const name = filename.toLowerCase();
    const basename = name.replace(/\.[^.]+$/, '');
    const exact = [name, name + ' image', basename, basename + ' image'];
    return [...list.querySelectorAll('[role="option"]')].filter(option => {
      if (!visible(option) || !enabled(option)) return false;
      const descendants = [...option.querySelectorAll('[title],[aria-label],img[alt]')];
      const labels = [label(option), option.textContent, ...descendants.flatMap(element =>
        [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('alt')])];
      return labels.some(value => exact.includes(value?.trim().replace(/\s+/g, ' ').toLowerCase()));
    });
  }

  function searchAssets(field, query) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    if (!(field instanceof HTMLInputElement)) return;
    setter.call(field, query);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function dismissPicker() {
    const picker = assetPicker();
    picker?.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  async function attachStyle(key, editor, file) {
    const scope = composerTray(editor);
    if (!scope) return { message: 'Flow’s reference tray could not be verified. Attach the style manually and send from Flow.' };
    if (assetPicker()) return { message: 'Close the ingredient picker before clicking Generate Images.' };
    const baseline = attachments(scope, file.name);
    const addedReference = currentEditor => {
      const currentScope = currentEditor && composerTray(currentEditor);
      if (!currentScope || uploadInProgress(currentScope)) return null;
      const current = attachments(currentScope, file.name);
      const added = [...current].filter(([token, item]) => item.ready && item.count > (baseline.get(token)?.count || 0));
      const delta = added.reduce((total, [token, item]) => total + item.count - (baseline.get(token)?.count || 0), 0);
      const preserved = [...baseline].every(([token, item]) => (current.get(token)?.count || 0) >= item.count);
      return delta === 1 && preserved ? added[0][0] : null;
    };
    const payload = new DataTransfer();
    payload.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      editor.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: payload }));
    }
    const started = Date.now();
    const deadline = started + 15000;
    let pickerOpened = false;
    let searched = false;
    let optionClicked = false;
    let confirmed = false;
    let dismissed = false;
    while (Date.now() < deadline) {
      const currentEditor = findEditor(key);
      if (project() !== key || (currentEditor && read(currentEditor).trim())) {
        return { message: 'The Flow project or draft changed while attaching the style. Check Flow before sending.' };
      }
      if (!currentEditor) {
        if (!optionClicked) return { message: 'The Agent draft is no longer available.' };
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      const warning = flowProblem(currentEditor, uploadProblem);
      if (warning) return { message: warning };
      const added = addedReference(currentEditor);
      if (added && !isBusy(currentEditor) && !assetPicker()) {
        return { ok: true, editor: currentEditor, stillAttached: () => addedReference(findEditor(key)) === added };
      }
      if (currentEditor !== editor && !optionClicked) {
        return { message: 'The Agent draft changed while attaching the style. Check Flow before sending.' };
      }
      if (!pickerOpened && Date.now() - started >= 1000 && !uploadInProgress(scope)) {
        const trigger = composerControl(currentEditor, ingredientLabel, scope);
        if (trigger && enabled(trigger)) {
          pickerOpened = true;
          trigger.click();
        }
      }
      const picker = pickerOpened && assetPicker();
      if (picker && added && !dismissed) {
        dismissed = true;
        dismissPicker();
      }
      if (picker && !added) {
        const matches = pickerOptions(picker.list, file.name);
        if (matches.length === 1) {
          const [option] = matches;
          if (!optionClicked) {
            optionClicked = true;
            option.click();
          } else if (!confirmed && option.getAttribute('aria-selected') === 'true' && enabled(picker.confirm)) {
            confirmed = true;
            picker.confirm.click();
          }
        } else if (!searched && !optionClicked) {
          searched = true;
          searchAssets(picker.search, file.name.replace(/\.[^.]+$/, ''));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (pickerOpened) dismissPicker();
    return { message: 'Flow did not confirm the style attachment.', prepareDraft: true };
  }

  async function sendOnce(key, editor, text, { reviewId, style } = {}) {
    const region = agentRegion(editor);
    if (!region) return { message: 'Open the expanded Flow Agent panel before using automatic submission.' };
    if (sending || (reviewId && usedReviews.has(reviewId))) return { message: 'A Flow submission is already in progress or was already attempted. Check Flow before proceeding.' };
    const blocked = flowProblem(editor, style && uploadProblem);
    if (blocked) return { message: blocked };
    if (isBusy(editor)) return { message: 'Flow is still working. Review run stopped.' };
    if (!composerControl(editor, sendLabel, region)) return { message: 'The Flow Agent Send button could not be verified.' };
    sending = true;
    if (reviewId) usedReviews.add(reviewId);
    try {
      let attachment;
      if (style) {
        if (read(editor).trim()) return { message: 'The Flow composer has a draft. Clear it before generating with a saved style.' };
        attachment = await attachStyle(key, editor, style);
        if (!attachment.ok) {
          const draftEditor = findEditor(key);
          if (attachment.prepareDraft && project() === key && draftEditor && !assetPicker() && !read(draftEditor).trim()) {
            const draft = insert(draftEditor, text, true, true);
            if (draft.ok) return { message: 'Prompt added to the Agent. Select the uploaded style under Add ingredients, then send.' };
          }
          return { message: attachment.message + (attachment.prepareDraft ? ' Select the uploaded style under Add ingredients and use Copy Prompt.' : '') };
        }
        editor = attachment.editor;
      }
      const result = insert(editor, text, true, Boolean(style));
      if (!result.ok) return result;
      await new Promise(resolve => setTimeout(resolve, 180));
      if (project() !== key || findEditor(key) !== editor || read(editor).trim() === '' ||
          normalize(read(editor), editor) !== normalize(text, editor)) {
        return { message: 'The Flow project or draft changed before submission.' };
      }
      if (attachment && !attachment.stillAttached()) return { message: 'Flow removed or changed the style attachment. The prompt remains in the Agent without sending.' };
      const warning = flowProblem(editor, style && uploadProblem);
      if (warning || isBusy(editor)) return { message: warning || 'Flow is busy.' };
      const currentRegion = agentRegion(editor);
      const send = currentRegion && composerControl(editor, sendLabel, currentRegion);
      if (!send || !enabled(send)) return { message: 'Flow did not enable Send. The review run stopped with the draft in place.' };
      send.click();
      for (let check = 0; check < 10; check++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (project() !== key) break;
        const currentEditor = findEditor(key);
        const failure = flowProblem(currentEditor);
        if (failure) return { message: failure };
        if (currentEditor && (isBusy(currentEditor) || (currentEditor === editor && !read(editor).trim()))) {
          return { ok: true, message: style ? 'Style attached and image request sent to Flow.' : 'Submitted once. Review the visible Flow result before continuing.' };
        }
      }
      return { message: 'Flow did not visibly acknowledge the submission. Check the Agent before starting a new run.' };
    } finally {
      sending = false;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const key = project();
    if (pendingPick && pendingPick.key !== key) pendingPick.cancel();
    const editor = key && findEditor(key);
    if (request.type === 'flow:context') {
      const busy = Boolean(editor && isBusy(editor));
      respond({ key, linked: Boolean(editor), picking: Boolean(pendingPick && !editor), linkIssue: editor ? '' : pickIssue,
        title: document.title, url: location.href, account: key ? projectAccount() : '', error: key ? flowProblem(editor) : '',
        busy, activity: activityFor(key, editor, busy), ...(key && request.preview ? { thumbnail: projectPreview(editor) } : {}) });
      return;
    }
    if (!key || request.key !== key) return respond({ message: 'The active Flow project changed.' });
    if (request.type === 'flow:link') {
      if (editor) {
        pendingPick?.cancel();
        return respond({ ok: true, linked: true });
      }
      chooseEditor(key);
      return respond({ ok: true, linked: false });
    }
    if (!['flow:insert', 'flow:send-reviewed', 'flow:generate-styled-sheets'].includes(request.type)) return;
    if (!editor) return respond({ message: 'Open Flow Agent and link its prompt box, or use Copy Prompt.' });
    if (typeof request.text !== 'string' || !request.text.trim()) return respond({ message: 'This prompt is empty.' });
    if (request.type === 'flow:insert') {
      const result = insert(editor, request.text);
      if (result.ok && request.action) {
        activity = { key, action: request.action, draft: normalize(read(editor), editor), started: false, finished: false };
      }
      return respond(result);
    }
    const styled = request.type === 'flow:generate-styled-sheets';
    let style;
    if (styled) {
      if (request.action !== 'createSheets') return respond({ message: 'Automatic style attachments are only available for Generate Images.' });
      try {
        style = referenceFile(request.reference);
      } catch {
        style = null;
      }
      if (!style) return respond({ message: 'The saved image could not be attached. Use Copy image or Save image.' });
    } else if (typeof request.reviewId !== 'string' || !request.reviewId) {
      return respond({ message: 'Review ID is missing.' });
    }
    sendOnce(key, editor, request.text, { reviewId: styled ? undefined : request.reviewId, style }).then(result => {
      if (result.ok && request.action) activity = { key, action: request.action, started: true, finished: false };
      respond(result);
    }, error => respond({ message: error.message }));
    return true;
  });
})();

