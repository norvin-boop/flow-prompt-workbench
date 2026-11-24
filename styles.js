let database;

function openLibrary() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('flow-style-library', 2);
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) request.result.createObjectStore('styles', { keyPath: 'id' });
        request.result.createObjectStore('deliveries', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onblocked = () => reject(new Error('Close older Workbench sidebars, then reopen this sidebar.'));
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = null;
      throw error;
    });
  }
  return database;
}

async function transact(mode, operation, store = 'styles') {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error('The style library could not be saved.'));
  });
}

export const readStyles = () => transact('readonly', store => store.getAll());
export const saveStyle = style => transact('readwrite', store => store.put(style));
export const readDelivery = id => transact('readonly', store => store.get(id), 'deliveries');
export const saveDelivery = delivery => transact('readwrite', store => store.put(delivery), 'deliveries');

export function encodeStyle(style) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      // Only this upload should match an asset in Flow, even if the old name is already in the project.
      name: style.name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 60) + ' - ' + crypto.randomUUID().slice(0, 12) + '.' + style.extension,
      data: reader.result
    });
    reader.onerror = () => reject(new Error('The saved style image could not be read.'));
    reader.readAsDataURL(style.blob);
  });
}

export async function toPng(blob) {
  const image = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not prepare the reference image.')), 'image/png');
    });
  } finally {
    image.close();
  }
}
