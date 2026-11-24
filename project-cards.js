import { describeProject, projectDeliveryKey, projectName } from './project-status.js';

const catalogKey = 'flow-project-catalog';
const accountKey = key => 'flow-project-account:' + key;

export function flowProjectUrl(value, key) {
  if (typeof key !== 'string' || !/^[\w-]+$/.test(key) || key === 'new') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^(.*\/project\/)([\w-]+)(?:\/|$)/);
    if (!match || match[2] !== key) return null;
    const base = match[1];
    const valid = (url.hostname === 'flow.google.com' && /^(?:\/u\/\d+)?\/project\/$/.test(base))
      || (url.hostname === 'labs.google' && /^\/(?:fx\/(?:[\w-]+\/)?(?:tools\/)?flow|flow)(?:\/u\/\d+)?\/project\/$/.test(base));
    if (!valid) return null;
    const authUser = url.searchParams.get('authuser');
    const projectUrl = new URL(url.origin + base + key);
    if (authUser && /^(?:\d+|[\w.+-]+@[\w.-]+\.[a-z]{2,})$/i.test(authUser)) projectUrl.searchParams.set('authuser', authUser);
    return projectUrl.href;
  } catch {
    return null;
  }
}

function thumbnailUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return /(^|\.)(googleusercontent\.com|gstatic\.com|googleapis\.com|flow\.google\.com)$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function detectedLabel(project) {
  if (project.account) return project.account;
  const url = new URL(project.url);
  const account = url.searchParams.get('authuser') || url.pathname.match(/\/u\/(\d+)\/project\//)?.[1];
  if (account?.includes('@')) return account;
  return account === undefined ? '' : 'Google account ' + (Number(account) + 1);
}

export function setupProjectCards({ $, status }) {
  const contexts = new Map();
  const remembered = new Map();
  const details = new Map();
  let live = [];
  let active = null;
  let activeDelivery = '';
  let signature = '';
  let refreshing = false;
  let switching = false;

  const catalog = chrome.storage.local.get(catalogKey).then(saved => {
    for (const entry of saved[catalogKey] || []) {
      const url = flowProjectUrl(entry.url, entry.key);
      if (url && !remembered.has(entry.key)) remembered.set(entry.key, { ...entry, url });
    }
    render();
  }).catch(error => status(error.message, true));

  function remember(projects) {
    const changed = [];
    for (const project of projects) {
      const url = flowProjectUrl(project.url, project.key);
      if (!url) continue;
      const entry = { key: project.key, url, title: projectName(project.title), account: detectedLabel({ ...project, url }) };
      const previous = remembered.get(entry.key);
      if (!entry.account && previous?.account && previous.url === entry.url) entry.account = previous.account;
      if (JSON.stringify(previous) === JSON.stringify(entry)) continue;
      remembered.set(entry.key, entry);
      changed.push(entry);
    }
    if (!changed.length) return;
    catalog.then(() => navigator.locks.request(catalogKey, async () => {
      const stored = (await chrome.storage.local.get(catalogKey))[catalogKey] || [];
      const merged = new Map(stored.map(entry => [entry.key, entry]));
      for (const entry of changed) {
        merged.delete(entry.key);
        merged.set(entry.key, entry);
      }
      await chrome.storage.local.set({ [catalogKey]: [...merged.values()].slice(-60) });
    })).catch(error => status(error.message, true));
  }

  function card(project) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const title = document.createElement('span');
    const account = document.createElement('span');
    const badge = document.createElement('span');
    const arrow = document.createElement('span');
    button.type = 'button';
    button.className = 'project-card';
    button.dataset.key = project.key;
    if (project.current) button.setAttribute('aria-current', 'page');
    title.className = 'project-card-title';
    title.textContent = project.name;
    account.className = 'project-card-account';
    account.textContent = project.account || 'Account not identified';
    badge.className = 'project-badge';
    badge.dataset.state = project.state.color || '';
    badge.textContent = project.state.label;
    if (project.current) badge.id = 'output-state';
    arrow.className = 'project-card-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');
    button.title = project.name + ' · ' + account.textContent + ' · ' + project.state.note;
    if (project.thumbnail) {
      const image = document.createElement('img');
      image.className = 'project-card-image';
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.loading = 'lazy';
      image.hidden = true;
      image.onload = () => { image.hidden = false; };
      image.src = project.thumbnail;
      button.append(image);
    }
    button.append(title, account, badge, arrow);
    button.addEventListener('click', () => openProject(project).catch(error => status(error.message, true)));
    row.append(button);
    return row;
  }

  function render() {
    const projects = new Map([...remembered].map(([key, context]) => [key, { ...context, offline: true }]));
    for (const context of live) {
      const previous = projects.get(context.key);
      if (!previous || previous.offline || (!previous.busy && context.busy)) {
        projects.set(context.key, { ...previous, ...context, account: context.account || previous?.account, offline: false });
      }
    }
    if (active) {
      const known = projects.get(active.key);
      const context = known?.busy && !active.busy && known.tabId !== active.tabId ? known : { ...known, ...active, offline: false };
      projects.set(active.key, { ...context, account: active.account || known?.account, delivery: activeDelivery });
    }
    const cards = [...projects.values()].map(project => {
      const saved = details.get(project.key) || {};
      const delivery = project.key === active?.key ? activeDelivery : saved.delivery;
      const state = project.offline && !delivery
        ? { label: 'Open in Flow', note: 'Open the project to refresh its status.' }
        : describeProject(project, delivery);
      return {
        key: project.key, tabId: project.tabId, url: flowProjectUrl(project.url, project.key),
        name: projectName(project.title), thumbnail: thumbnailUrl(project.thumbnail),
        account: saved.alias || project.account, current: project.key === active?.key, state
      };
    }).filter(project => project.url || project.current);
    cards.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    const next = JSON.stringify(cards);
    if (next === signature) return;
    signature = next;
    const focusKey = document.activeElement?.dataset.key;
    const rows = cards.map(card);
    $('projects-empty').hidden = cards.length > 0;
    $('project-cards').replaceChildren(...rows);
    if (focusKey) rows.find(row => row.firstChild.dataset.key === focusKey)?.firstChild.focus({ preventScroll: true });
  }

  async function openProject(project) {
    if (switching) return;
    switching = true;
    try {
      remember(live);
      remember(active ? [active] : []);
      const id = project.tabId;
      const context = id === undefined ? null : await chrome.tabs.sendMessage(id, { type: 'flow:context' }).catch(() => null);
      const existing = id === undefined || context ? null : await chrome.tabs.get(id).catch(() => null);
      const discarded = existing?.discarded && contexts.get(id)?.context?.key === project.key;
      if (context?.key !== project.key && !discarded) {
        if (!project.url) throw new Error('The Flow project tab is no longer available.');
        await chrome.tabs.create({ url: project.url });
        return;
      }
      const tab = await chrome.tabs.update(id, { active: true });
      if (tab?.windowId !== undefined && chrome.windows?.update) await chrome.windows.update(tab.windowId, { focused: true });
    } finally {
      switching = false;
    }
  }

  async function loadDetails(projects) {
    const keys = [...new Set(projects.map(project => project.key))];
    if (!keys.length) return;
    const saved = await chrome.storage.local.get(keys.flatMap(key => [accountKey(key), projectDeliveryKey(key)]));
    for (const key of keys) details.set(key, { alias: saved[accountKey(key)] || '', delivery: saved[projectDeliveryKey(key)] });
  }

  async function refresh() {
    if (refreshing || $('pane-output').hidden) return;
    refreshing = true;
    try {
      await catalog;
      const tabs = await chrome.tabs.query({});
      const now = Date.now();
      const existingIds = new Set(tabs.map(tab => tab.id));
      for (const id of contexts.keys()) if (!existingIds.has(id)) contexts.delete(id);
      await Promise.all(tabs.map(async tab => {
        const existing = contexts.get(tab.id);
        if (!tab.id || tab.discarded || tab.status === 'loading' || (existing && !existing.context && !existing.flow && now - existing.checked < 30000)) return;
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'flow:context', preview: true }).catch(() => null);
        const context = response && flowProjectUrl(response.url, response.key) ? { ...response, tabId: tab.id } : null;
        if (!response && existing?.context) return; // A sleeping or briefly unresponsive tab keeps its last known context.
        contexts.set(tab.id, { context, checked: now, flow: Boolean(response) });
      }));
      live = [...contexts.values()].map(item => item.context).filter(Boolean);
      remember(live);
      await loadDetails([...remembered.values()]);
      render();
    } finally {
      refreshing = false;
    }
  }

  function refreshSafely() {
    refresh().catch(error => status(error.message, true));
  }

  $('project-account-label').addEventListener('change', async () => {
    if (!active) return;
    const key = active.key;
    const alias = $('project-account-label').value.trim();
    try {
      await chrome.storage.local.set({ [accountKey(key)]: alias });
      details.set(key, { ...details.get(key), alias });
      render();
    } catch (error) {
      status(error.message, true);
    }
  });
  for (const event of ['click', 'focus']) $('tab-output').addEventListener(event, () => queueMicrotask(refreshSafely));
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'complete') {
      contexts.delete(tabId);
      refreshSafely();
    }
  });
  setInterval(refreshSafely, 4500);

  return {
    observe(context, delivery) {
      const changed = context?.key !== active?.key;
      active = context;
      activeDelivery = delivery || '';
      if (context) remember([context]);
      if (changed && context) {
        const field = $('project-account-label');
        field.value = details.get(context.key)?.alias || '';
        field.placeholder = remembered.get(context.key)?.account || 'e.g. Work Google account';
        loadDetails([context]).then(() => {
          if (active?.key === context.key && document.activeElement !== field) field.value = details.get(context.key)?.alias || '';
          render();
        }).catch(error => status(error.message, true));
      }
      render();
    }
  };
}

