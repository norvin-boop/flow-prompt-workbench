import { browserRunBrief, checkpoints, makeReviewPacket, parseDecision, reviewedPrompt } from './review.js';

export function setupReviewPanel({ $, on, status, currentTarget, getSettings, getPrompt, showPreview, isCurrent }) {
  let currentKey = null;
  let run = null;
  let operation = false;
  const storeKey = key => 'flow-review-run:' + key;
  const stopped = reason => ({ state: 'stopped', reason });

  function showRun() {
    const state = run?.state;
    const terminal = state === 'stopped' || state === 'done';
    if (run?.stage) $('checkpoint').value = run.stage;
    $('checkpoint').disabled = operation || Boolean(state);
    $('copy-review').disabled = operation || terminal || state === 'dispatching';
    $('copy-browser-run').disabled = operation || Boolean(state);
    $('apply-decision').disabled = operation || state !== 'review';
    $('stop-run').disabled = operation || !state || terminal;
    $('send-reviewed').disabled = operation || terminal;
    $('reset-run').hidden = !terminal;
    $('run-status').dataset.state = state || 'idle';
    $('run-status').textContent = run?.reason || 'No review requested.';
  }

  async function getRun(key) {
    const name = storeKey(key);
    return (await chrome.storage.local.get(name))[name] ?? null;
  }

  async function withRun(key, handler) {
    // The persistent state and this per-project lock prevent duplicate attempts across sidebars.
    return navigator.locks.request(storeKey(key), async () => {
      const save = async next => {
        const name = storeKey(key);
        if (next) await chrome.storage.local.set({ [name]: next });
        else await chrome.storage.local.remove(name);
        if (currentKey === key) {
          run = next;
          showRun();
        }
      };
      return handler(await getRun(key), save);
    });
  }

  function settingsSignature() {
    const { model, veoSeconds, omniSeconds, audio, script, styleId, demographic, aspectRatio } = getSettings();
    return JSON.stringify([model, model === 'veo' ? veoSeconds : omniSeconds, audio, script, styleId, demographic, aspectRatio]);
  }

  async function guarded(handler) {
    if (operation) return;
    operation = true;
    showRun();
    try {
      const target = await currentTarget();
      await handler(target);
    } finally {
      operation = false;
      showRun();
    }
  }

  async function copy(title, text) {
    showPreview(title, text);
    await navigator.clipboard.writeText(text);
  }

  for (const step of checkpoints) $('checkpoint').add(new Option(step.label, step.id));
  showRun();

  on('copy-browser-run', 'click', () => guarded(async target => {
    if (target.error || target.busy) throw new Error(target.error || 'Flow is still working.');
    if (await getRun(target.key)) throw new Error('Finish or stop the active review relay before copying a browser run.');
    const provider = $('provider').value;
    const prompts = Object.fromEntries(checkpoints.map(step => [step.next, getPrompt(step.next)]));
    await copy(provider + ' · Browser Automation Brief', browserRunBrief(provider, getSettings(), $('checkpoint').value, prompts));
    status('Copied. Paste into a browser-capable assistant to begin the bounded run.');
  }));

  on('copy-review', 'click', () => guarded(async target => {
    const stage = $('checkpoint').value;
    const provider = $('provider').value;
    const evidence = $('review-evidence').value;
    await withRun(target.key, async (saved, save) => {
      if (saved?.state === 'stopped' || saved?.state === 'done' || saved?.state === 'dispatching') {
        throw new Error('Start a new review run before requesting another decision.');
      }
      if (target.error) {
        await save(stopped(target.error));
        throw new Error('Review run stopped. ' + target.error);
      }
      if (target.busy) throw new Error('Flow is still working. Wait for a visible result before requesting review.');
      // Build the next action now so missing project settings are caught before review.
      getPrompt(checkpoints.find(item => item.id === stage).next);
      const signature = settingsSignature();
      const request = saved?.state === 'review' && saved.signature === signature
        ? saved
        : { state: 'review', stage: saved?.stage || stage, id: crypto.randomUUID(), signature, reason: 'Awaiting the assistant’s decision.' };
      await save(request);
      await copy(provider + ' · Review Request', makeReviewPacket(provider, request, getSettings(), evidence));
      status('Review request copied. Provide the actual Flow evidence to the assistant.');
    });
  }));

  on('apply-decision', 'click', () => guarded(async target => {
    const input = $('decision').value;
    const send = $('send-reviewed').checked;
    await withRun(target.key, async (saved, save) => {
      const verdict = parseDecision(input, saved);
      if (verdict.decision === 'stop' || target.error) {
        const reason = target.error || verdict.reason;
        await save(stopped(reason));
        status('Review run stopped. ' + reason, true);
        return;
      }
      if (verdict.decision === 'hold') {
        await save({ ...saved, reason: 'On hold. ' + verdict.reason });
        status('On hold. No Flow request was made.');
        return;
      }
      if (saved.signature !== settingsSignature() || !isCurrent(target)) {
        await save(stopped('Project settings or the active tab changed during review.'));
        throw new Error('Review run stopped. Start a fresh review for the current settings.');
      }
      if (target.busy) {
        await save(stopped('Flow was still working when the decision was applied.'));
        throw new Error('Review run stopped. Verify the current Flow result.');
      }
      const index = checkpoints.findIndex(item => item.id === saved.stage);
      const step = checkpoints[index];
      const text = reviewedPrompt(getPrompt(step.next), saved.stage, verdict.approved);
      showPreview('Approved · ' + step.label, text);
      // Consume the review and persist before any action in Flow. A reload cannot replay it.
      await save({ ...saved, state: 'dispatching', reason: 'Applying one approved step…' });
      let outcome;
      try {
        outcome = await chrome.tabs.sendMessage(target.tabId, {
          type: send ? 'flow:send-reviewed' : 'flow:insert', key: target.key, reviewId: saved.id, action: step.next, text
        });
      } catch {
        outcome = { message: 'The Flow tab did not confirm the action.' };
      }
      if (!outcome?.ok) {
        const reason = outcome?.message || 'Flow did not confirm the action.';
        await save(stopped(reason));
        status('Review run stopped. ' + reason, true);
        return;
      }
      if (isCurrent(target)) {
        $('decision').value = '';
        $('review-evidence').value = '';
      }
      const next = checkpoints[index + 1];
      const reason = outcome.message;
      await save(next ? { state: 'waiting', stage: next.id, reason } : {
        state: 'done',
        reason: send ? 'Collection request submitted once. Verify the result in Flow.' : 'Collection prompt prepared. Send it and verify the result in Flow.'
      });
      status(reason);
    });
  }));

  on('stop-run', 'click', () => guarded(target => withRun(target.key, async (_saved, save) => {
    await save(stopped('Stopped by the specialist.'));
    status('Review run stopped.');
  })));

  on('reset-run', 'click', () => guarded(target => withRun(target.key, async (saved, save) => {
    if (saved?.state !== 'stopped' && saved?.state !== 'done') return;
    if (target.error || target.busy) throw new Error('Resolve the visible Flow problem or wait for work to finish before starting another run.');
    await save(null);
    $('decision').value = '';
    $('review-evidence').value = '';
    $('send-reviewed').checked = false;
    status('New review run ready.');
  })));

  return {
    async load(key) {
      currentKey = key;
      run = null;
      $('checkpoint').value = checkpoints[0].id;
      $('decision').value = '';
      $('review-evidence').value = '';
      $('send-reviewed').checked = false;
      showRun();
      if (!key) return;
      const saved = await getRun(key);
      if (currentKey !== key) return;
      if (saved?.state === 'dispatching') {
        await withRun(key, async (latest, save) => {
          if (latest?.state === 'dispatching') await save(stopped('The previous attempt was interrupted. Verify Flow before starting a new run.'));
          else if (currentKey === key) {
            run = latest;
            showRun();
          }
        });
      } else {
        run = saved;
        showRun();
      }
    },
    async observe(context) {
      if (!context?.error || context.key !== currentKey || !run || !['review', 'waiting', 'done'].includes(run.state)) return;
      await withRun(context.key, async (saved, save) => {
        if (saved && ['review', 'waiting', 'done'].includes(saved.state)) {
          await save(stopped(context.error));
          if (currentKey === context.key) status('Review run stopped. ' + context.error, true);
        }
      });
    }
  };
}

