import { readDelivery, saveDelivery } from './styles.js';
import { deliveryZip } from './zip.js';
import { driveFolder, driveUploadLimit, uploadZip } from './drive.js';
import { setupProjectCards } from './project-cards.js';
import { describeProject, projectDeliveryKey, projectName } from './project-status.js';

function readableSize(size) {
  return size >= 1024 * 1024
    ? (size / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.max(1, Math.round(size / 1024)) + ' KB';
}

export function setupOutputPanel({ $, on, status, persistFolder, driveAccount }) {
  let active = null;
  let delivery = null;
  let transfer = null;
  let zipUrl = '';
  let working = false;
  let uploadJob = null;
  let packaging = false;
  let loadNumber = 0;
  const transferKey = packageId => 'flow-zip-upload:' + packageId;
  const cards = setupProjectCards({ $, status });

  function updateFolder(value) {
    if ($('upload-link').value !== value) $('upload-link').value = value;
    render();
  }

  function title() {
    return projectName(active?.title);
  }

  function showDelivery() {
    if (zipUrl) URL.revokeObjectURL(zipUrl);
    zipUrl = delivery && URL.createObjectURL(delivery.file);
    $('download-zip').hidden = !zipUrl;
    if (zipUrl) {
      $('download-zip').href = zipUrl;
      $('download-zip').download = delivery.file.name;
    } else {
      $('download-zip').removeAttribute('href');
    }
  }

  function render() {
    $('output-project').hidden = !active;
    $('project-account-editor').hidden = !active;
    const job = uploadJob && uploadJob.packageId === delivery?.packageId ? uploadJob : null;
    const deliveryState = job ? 'uploading' : transfer?.state || (delivery ? 'ready' : '');
    cards.observe(active, deliveryState, uploadJob);
    if (!active) return;
    $('output-title').textContent = title();
    $('output-note').textContent = describeProject(active, deliveryState).note;
    $('zip-info').textContent = packaging ? 'Packaging your selected files…' : delivery
      ? delivery.file.name + ' · ' + readableSize(delivery.file.size)
      : 'Add the approved collection ZIP from Flow, or choose approved videos to package.';
    $('output-files').disabled = packaging || working;
    const folder = driveFolder($('upload-link').value);
    const authorized = driveAccount.canUpload(folder);
    $('open-folder').hidden = !folder;
    if (folder) $('open-folder').href = folder.url;
    else $('open-folder').removeAttribute('href');
    $('send-zip').disabled = !delivery || !folder || !authorized || working || packaging || delivery.file.size > driveUploadLimit
      || transfer?.state === 'uploaded' || transfer?.state === 'check' || transfer?.state === 'uploading';
    $('upload-link').disabled = working;
    $('allow-resend').hidden = working || transfer?.state !== 'check';
    const progress = $('upload-progress');
    progress.hidden = !job && transfer?.state !== 'uploaded';
    if (job && Number.isFinite(job.percent)) progress.value = job.percent;
    else if (transfer?.state === 'uploaded') progress.value = 100;
    else progress.removeAttribute('value');
    $('authorize-drive').hidden = !folder || authorized || working;
    const uploadedUrl = transfer?.state === 'uploaded' && /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(transfer.url || '');
    $('uploaded-file').hidden = !uploadedUrl;
    if (uploadedUrl) $('uploaded-file').href = transfer.url;
    else $('uploaded-file').removeAttribute('href');
    $('upload-status').textContent = delivery?.file.size > driveUploadLimit
      ? 'For ZIPs larger than 512 MB, download the file and upload it from the Drive folder.'
      : job?.message || transfer?.message || (folder && !authorized ? 'Authorize this folder in Presets & Settings, or use Download ZIP and Open folder.' : '');
  }
  driveAccount.observe(render);

  async function saveTransfer(record, next) {
    const summaryKey = projectDeliveryKey(record.id);
    await navigator.locks.request(summaryKey, async () => {
      const latest = await readDelivery(record.id);
      const summary = latest?.packageId === record.packageId ? { [summaryKey]: next.state } : {};
      await chrome.storage.local.set({ [transferKey(record.packageId)]: next, ...summary });
    });
    if (delivery?.packageId === record.packageId) {
      transfer = next;
      render();
    }
  }

  on('output-files', 'change', async () => {
    const input = $('output-files');
    const files = [...input.files];
    input.value = '';
    if (!active || !files.length || packaging || working) return;
    const key = active.key;
    const projectTitle = title();
    packaging = true;
    render();
    try {
      const file = await deliveryZip(files, projectTitle);
      const record = { id: key, packageId: crypto.randomUUID(), file };
      const summaryKey = projectDeliveryKey(key);
      await navigator.locks.request(summaryKey, async () => {
        await saveDelivery(record);
        await chrome.storage.local.set({ [summaryKey]: 'ready' });
      });
      if (active?.key === key) {
        delivery = record;
        transfer = null;
        showDelivery();
        status('Delivery ZIP is ready.');
      }
    } finally {
      packaging = false;
      render();
    }
  });

  on('upload-link', 'input', render);
  on('upload-link', 'change', async () => persistFolder($('upload-link').value));
  on('authorize-drive', 'click', () => {
    $('tab-settings').click();
    $('drive-settings').open = true;
    $('drive-settings').scrollIntoView({ block: 'nearest' });
  });
  on('allow-resend', 'click', async () => {
    if (!delivery || transfer?.state !== 'check' || working) return;
    await saveTransfer(delivery, { state: 'failed', message: 'Retry unlocked. Check the destination for an existing ZIP before sending.' });
  });
  on('upload-form', 'submit', async event => {
    event.preventDefault();
    const folder = driveFolder($('upload-link').value);
    const record = delivery;
    if (!record || !folder || $('send-zip').disabled) return;
    working = true;
    uploadJob = { packageId: record.packageId, projectKey: record.id, message: 'Checking your Google account and folder…' };
    render();
    try {
      await navigator.locks.request(transferKey(record.packageId), async () => {
        const key = transferKey(record.packageId);
        const existing = (await chrome.storage.local.get(key))[key];
        if (['check', 'uploaded', 'uploading'].includes(existing?.state)) {
          throw new Error('Check the existing Drive upload before sending this ZIP again.');
        }
        let dispatched = false;
        const destination = { folder: folder.url };
        try {
          const result = await uploadZip(folder, record.file, driveAccount.request, async () => {
            await saveTransfer(record, { ...destination, state: 'check', message: 'Check the Drive folder before sending again.' });
            dispatched = true;
          }, progress => {
            uploadJob = { ...uploadJob, ...progress, percent: progress.percent };
            render();
          });
          await saveTransfer(record, { ...destination, ...result });
          if (delivery?.packageId === record.packageId) status(result.message, result.state !== 'uploaded');
        } catch (error) {
          const message = dispatched ? error.message + ' Check the destination before sending again.' : error.message;
          await saveTransfer(record, { ...destination, state: dispatched ? 'check' : 'failed', message });
          throw new Error(message);
        }
      });
    } finally {
      working = false;
      uploadJob = null;
      render();
    }
  });

  return {
    async load(context, folder) {
      const sequence = ++loadNumber;
      if (context?.key !== active?.key) {
        $('output-project').open = false;
        $('project-account-editor').open = false;
      }
      active = context;
      delivery = null;
      transfer = null;
      showDelivery();
      updateFolder(folder);
      if (!context) return;
      const saved = await readDelivery(context.key);
      const key = saved && transferKey(saved.packageId);
      const summaryKey = projectDeliveryKey(context.key);
      const savedDetails = key ? await chrome.storage.local.get([key, summaryKey]) : {};
      const savedTransfer = key ? savedDetails[key] : null;
      if (sequence !== loadNumber) return;
      delivery = saved;
      transfer = savedTransfer;
      showDelivery();
      render();
      if (saved && !savedDetails[summaryKey]) {
        await navigator.locks.request(summaryKey, async () => {
          if (!(await chrome.storage.local.get(summaryKey))[summaryKey]) {
            await chrome.storage.local.set({ [summaryKey]: savedTransfer?.state || 'ready' });
          }
        });
      }
    },
    observe(context) {
      if (context?.key !== active?.key) return;
      active = context;
      render();
    },
    updateFolder
  };
}

