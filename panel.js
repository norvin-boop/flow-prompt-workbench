import { audioActions, defaultPreset, defaultSettings, getPreset, makePrompt, migrateSettings, modes, presetKey, stages } from './prompts.js';
import { setupReviewPanel } from './review-panel.js';
import { encodeStyle, readStyles, saveStyle, toPng } from './styles.js';
import { driveFolder } from './drive.js';
import { setupOutputPanel } from './output-panel.js';
import { setupStyleViewer, setupTabs } from './view-controls.js';

const $ = id => document.getElementById(id);
const optionActions = stages.flatMap(stage => stage.actions);
const actionNames = Object.fromEntries(optionActions);
const presetsStorage = 'flow-workbench-presets-v1';
const audioHelp = {
  dialogue: 'On-screen characters speak the script with lip-sync.',
  narration: 'An off-screen voice reads the script while the characters act silently.',
  silent: 'The shot direction leaves out dialogue and narration.'
};
let active = null;
let settings = { ...defaultSettings };
let overrides = {};
let styles = [];
let previewUrl;
let refreshNumber = 0;
let busy = false;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

function on(id, event, handler) {
  $(id).addEventListener(event, async occurrence => {
    try {
      await handler(occurrence);
    } catch (error) {
      status(error.message || 'The action could not be completed.', true);
    }
  });
}

function projectKey(key) {
  return 'project-v1:' + key;
}

async function saveSetting(name, value) {
  if (!active) return;
  settings[name] = value;
  await chrome.storage.local.set({ [projectKey(active.key)]: { settings } });
}

async function getFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const context = await chrome.tabs.sendMessage(tab.id, { type: 'flow:context' }).catch(() => null);
  return context?.key ? { ...context, tabId: tab.id } : null;
}

function showFolder() {
  const folder = driveFolder(settings.uploadFolder);
  $('uploadFolder').setCustomValidity(settings.uploadFolder && !folder ? 'Enter a Google Drive folder link.' : '');
  outputPanel.updateFolder(settings.uploadFolder);
}

function showModelAndAudio() {
  const veo = settings.model === 'veo';
  $('route').textContent = veo ? 'Veo 3.1 Lite' : 'Omni Flash 1.2';
  $('veo-length').hidden = !veo;
  $('omni-length').hidden = veo;
  $('audio-help').textContent = audioHelp[settings.audio] || 'Choose how the script will be heard.';
  $('ratio-help').hidden = !['1:1', '4:5'].includes(settings.aspectRatio);
}

function selectedStyle() {
  return styles.find(style => style.id === settings.styleId);
}

function showStyleOptions() {
  $('styleId').replaceChildren(
    new Option('Use a reference attached in Flow', ''),
    ...styles.map(style => new Option(style.name, style.id))
  );
  const style = selectedStyle();
  $('styleId').value = style?.id || '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = style ? URL.createObjectURL(style.blob) : null;
  $('style-preview').hidden = !style;
  $('style-help').textContent = style
    ? 'Generate Images attaches this reference and sends the prompt to Flow Agent.'
    : 'Attach a style image in Flow, or add one to your Style Library for reuse.';
  if (style) {
    $('style-image').src = previewUrl;
    $('style-image').alt = style.name + ' reference';
    $('download-style').href = previewUrl;
    $('download-style').download = style.name.replace(/[<>:"/\\|?*]/g, '_') + '.' + style.extension;
  } else {
    $('style-image').removeAttribute('src');
    $('download-style').removeAttribute('href');
  }
}

function showSettings() {
  for (const name of Object.keys(defaultSettings)) {
    if (name !== 'styleId') $(name).value = settings[name];
  }
  $('preset-mode').value = modes[settings.audio] ? settings.audio : 'dialogue';
  showPreset();
  showModelAndAudio();
  showStyleOptions();
  showFolder();
}

function button(label, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

function styleName(value, existingId) {
  const name = value.trim();
  if (!name) throw new Error('Enter a style name.');
  if (styles.some(style => style.id !== existingId && style.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('A style with that name already exists.');
  }
  return name;
}

function showStyles() {
  styles.sort((a, b) => a.name.localeCompare(b.name));
  $('styles-list').replaceChildren();
  for (const style of styles) {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = style.name;
    const view = button('View', 'text-button');
    view.setAttribute('aria-label', 'View ' + style.name);
    view.addEventListener('click', () => viewStyle(style));
    const rename = button('Rename', 'text-button');
    const controls = document.createElement('div');
    controls.className = 'buttons';
    controls.append(view, rename);
    rename.setAttribute('aria-label', 'Rename ' + style.name);
    rename.addEventListener('click', () => {
      const field = document.createElement('input');
      field.value = style.name;
      field.maxLength = 72;
      field.setAttribute('aria-label', 'New style name');
      const save = button('Save', 'text-button');
      const cancel = button('Cancel', 'text-button');
      const submit = async () => {
        save.disabled = true;
        try {
          const name = styleName(field.value, style.id);
          const updated = { ...style, name };
          await saveStyle(updated);
          styles = styles.map(item => item.id === updated.id ? updated : item);
          showStyles();
          status('Style renamed to ' + name + '.');
        } catch (error) {
          status(error.message, true);
          save.disabled = false;
        }
      };
      save.addEventListener('click', submit);
      field.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !save.disabled) submit();
        if (event.key === 'Escape') row.replaceChildren(title, controls);
      });
      cancel.addEventListener('click', () => row.replaceChildren(title, controls));
      row.replaceChildren(field, save, cancel);
      field.select();
    });
    row.append(title, controls);
    $('styles-list').append(row);
  }
  showStyleOptions();
}

async function refresh() {
  const refreshId = ++refreshNumber;
  const next = await getFlowTab();
  if (refreshId !== refreshNumber) return;
  if (next?.key !== active?.key || next?.tabId !== active?.tabId) {
    let saved;
    if (next) {
      const key = projectKey(next.key);
      const previousKey = 'project:' + next.key;
      const records = await chrome.storage.local.get([key, previousKey]);
      saved = records[key] ?? records[previousKey];
      if (refreshId !== refreshNumber) return;
    }
    active = next;
    settings = migrateSettings(saved?.settings);
    $('project').hidden = !next;
    $('no-project').hidden = Boolean(next);
    $('preview-card').hidden = true;
    $('preview-card').open = false;
    $('preview').value = '';
    if (next) {
      $('setup').open = !saved || !settings.audio;
      showSettings();
      status('Choose a workflow action.');
    } else {
      status('Waiting for a Flow project.');
    }
    await Promise.all([reviewPanel.load(next?.key), outputPanel.load(next, settings.uploadFolder)]);
    if (refreshId !== refreshNumber) return;
  } else {
    active = next;
  }
  $('link-editor').disabled = !next;
  $('agent-state').dataset.ready = String(Boolean(next?.linked));
  $('agent-state').dataset.picking = String(Boolean(next?.picking));
  $('connection').textContent = next?.linked ? 'Agent ready' : next?.picking ? 'Click the Agent prompt field' : next ? 'Agent not linked' : 'No Flow project open';
  $('agent-state').title = next?.linkIssue || '';
  outputPanel.observe(next);
  if (next?.linked && $('status').textContent.startsWith('Click inside')) status('Agent linked. Workflow prompts are ready to insert.');
  else if (next?.linkIssue && $('status').textContent.startsWith('Click inside')) status(next.linkIssue, true);
  await reviewPanel.observe(next);
}

async function currentTarget() {
  const intended = active;
  const current = await getFlowTab();
  if (!intended || !current || intended.key !== current.key || intended.tabId !== current.tabId
      || active?.tabId !== current.tabId || active?.key !== current.key) {
    throw new Error('Open the intended Flow project and try again.');
  }
  return current;
}

function showPreview(name, text) {
  $('preview').value = text;
  $('preview-label').textContent = name;
  $('preview-card').hidden = false;
  $('preview-card').open = true;
}

const reviewPanel = setupReviewPanel({
  $, on, status, currentTarget, showPreview,
  getSettings: () => settings,
  getPrompt: action => makePrompt(action, settings, selectedStyle(), overrides),
  isCurrent: target => active?.key === target.key && active?.tabId === target.tabId
});
const outputPanel = setupOutputPanel({
  $, on, status,
  persistFolder: async value => {
    const saving = saveSetting('uploadFolder', value);
    $('uploadFolder').value = value;
    showFolder();
    await saving;
  }
});
setupTabs();
const viewStyle = setupStyleViewer($);
on('zoom-style', 'click', () => viewStyle(selectedStyle()));

async function prepare(action) {
  if (busy || !active) return;
  const style = action === 'createSheets' ? selectedStyle() : null;
  const text = makePrompt(action, settings, style, overrides);
  showPreview(actionNames[action], text);
  busy = true;
  try {
    const target = await currentTarget();
    if (style) status('Attaching ' + style.name + ' in Flow…');
    const reference = style ? await encodeStyle(style) : null;
    if (reference) {
      const confirmed = await currentTarget();
      if (confirmed.key !== target.key || confirmed.tabId !== target.tabId || selectedStyle()?.id !== style.id) {
        throw new Error('The project or selected style changed. Choose Generate Images again.');
      }
    }
    const result = await chrome.tabs.sendMessage(target.tabId, {
      type: reference ? 'flow:generate-styled-sheets' : 'flow:insert',
      key: target.key, action, text, reference
    });
    if (!result) throw new Error('Refresh the Flow tab to connect the extension, or use Copy Prompt.');
    status(result.message, !result.ok);
    if (!result.ok) $('preview-card').scrollIntoView({ block: 'nearest' });
  } finally {
    busy = false;
  }
}

function setupActions() {
  stages.forEach((stage, index) => {
    const item = document.createElement('li');
    const header = document.createElement('div');
    const step = document.createElement('span');
    const heading = document.createElement('h3');
    const hint = document.createElement('p');
    item.className = 'stage';
    header.className = 'stage-heading';
    step.className = 'step';
    step.textContent = index + 1;
    heading.textContent = stage.title;
    hint.className = 'hint';
    hint.textContent = stage.note;
    header.append(step, heading);
    item.append(header, hint);
    for (const [action, name] of stage.actions) {
      const run = button(name);
      const arrow = document.createElement('span');
      arrow.textContent = '→';
      arrow.setAttribute('aria-hidden', 'true');
      run.append(arrow);
      run.addEventListener('click', () => prepare(action).catch(error => status(error.message, true)));
      item.append(run);
    }
    $('actions').append(item);
  });
  for (const [action, name] of optionActions) {
    $('preset-action').add(new Option(name, action));
  }
}

function showPreset() {
  const action = $('preset-action').value;
  const audio = $('preset-mode').value;
  $('preset-mode-label').hidden = !audioActions.has(action);
  $('preset-hint').textContent = audioActions.has(action)
    ? 'This version applies only to the selected audio mode.'
    : 'This prompt is shared across audio modes.';
  $('preset-text').value = getPreset(action, audio, overrides);
}

setupActions();
$('version').textContent = 'v' + chrome.runtime.getManifest().version;
for (const name of Object.keys(defaultSettings)) {
  on(name, 'change', async () => {
    const saving = saveSetting(name, $(name).value);
    if (name === 'audio') {
      $('preset-mode').value = settings.audio;
      showPreset();
    }
    showModelAndAudio();
    if (name === 'styleId') showStyleOptions();
    if (name === 'uploadFolder') {
      showFolder();
      if (settings.uploadFolder && !driveFolder(settings.uploadFolder)) status('Enter a Google Drive folder link.', true);
    }
    await saving;
  });
}

on('theme', 'change', async () => {
  document.documentElement.dataset.theme = $('theme').value;
  await chrome.storage.local.set({ theme: $('theme').value });
});

on('link-editor', 'click', async () => {
  const target = await currentTarget();
  const result = await chrome.tabs.sendMessage(target.tabId, { type: 'flow:link', key: target.key });
  if (!result?.ok) throw new Error('Refresh the Flow tab and try linking again.');
  status(result.linked ? 'Agent is already linked. Choose a workflow action.' : 'Click inside the open Agent prompt box in Flow within 30 seconds.');
  refreshSafely();
});

on('style-form', 'submit', async event => {
  event.preventDefault();
  const project = active?.key;
  const name = styleName($('style-name').value);
  const file = $('style-file').files[0];
  if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP, or AVIF reference image.');
  }
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image up to 20 MB.');
  $('save-style').disabled = true;
  try {
    const bitmap = await createImageBitmap(file);
    bitmap.close();
    const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
    const style = { id: crypto.randomUUID(), name, extension, blob: file };
    await saveStyle(style);
    styles.push(style);
    if (project && active?.key === project) await saveSetting('styleId', style.id);
    $('style-form').reset();
    showStyles();
    status('Saved ' + name + ' to the Style Library.');
  } finally {
    $('save-style').disabled = false;
  }
});

on('copy-image', 'click', async () => {
  const style = selectedStyle();
  if (!style) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(style.blob) })]);
    status('Reference copied. Paste it into Flow or attach the saved image.');
  } catch {
    throw new Error('Could not copy the reference. Use Save image and attach it in Flow.');
  }
});
on('copy', 'click', async () => {
  await navigator.clipboard.writeText($('preview').value);
  status('Prompt copied.');
});
on('preset-action', 'change', showPreset);
on('preset-mode', 'change', showPreset);
on('save-preset', 'click', async () => {
  const text = $('preset-text').value.trim();
  if (!text) throw new Error('Enter a prompt before saving.');
  overrides[presetKey($('preset-action').value, $('preset-mode').value)] = text;
  await chrome.storage.local.set({ [presetsStorage]: overrides });
  status('Preset saved for this browser.');
});
on('restore-preset', 'click', async () => {
  delete overrides[presetKey($('preset-action').value, $('preset-mode').value)];
  await chrome.storage.local.set({ [presetsStorage]: overrides });
  showPreset();
  status('Default preset restored.');
});

function refreshSafely() {
  refresh().catch(error => status(error.message, true));
}

chrome.tabs.onActivated.addListener(refreshSafely);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url || change.status === 'complete') refreshSafely();
});
setInterval(refreshSafely, 1250);

try {
  const saved = await chrome.storage.local.get([presetsStorage, 'prompt-overrides', 'theme']);
  overrides = saved[presetsStorage] ?? {};
  if (!saved[presetsStorage] && saved['prompt-overrides']) {
    for (const [action, value] of Object.entries(saved['prompt-overrides'])) {
      if (!(action in actionNames)) continue;
      if (audioActions.has(action)) {
        for (const audio of Object.keys(modes)) {
          const audioInstruction = defaultPreset(action, audio).split('\n\n').at(-1);
          overrides[presetKey(action, audio)] = value + '\n\n' + audioInstruction;
        }
      } else {
        overrides[action] = value;
      }
    }
    await chrome.storage.local.set({ [presetsStorage]: overrides });
  }
  $('theme').value = saved.theme || 'system';
  document.documentElement.dataset.theme = $('theme').value;
  showPreset();
  styles = await readStyles();
  showStyles();
  refreshSafely();
} catch (error) {
  status(error.message, true);
}

