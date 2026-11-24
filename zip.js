const encoder = new TextEncoder();
const maxSize = 0xffffffff;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = (index & 1) ? (index >>> 1) ^ 0xedb88320 : index >>> 1;
  return index;
});

async function crc32(file) {
  let crc = 0xffffffff;
  for await (const chunk of file.stream()) {
    for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function deliveryZip(files, title) {
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const file = files[0];
    const tail = new Uint8Array(await file.slice(-65557).arrayBuffer());
    const view = new DataView(tail.buffer);
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === tail.length) {
        if (!view.getUint16(offset + 10, true)) throw new Error('Choose a ZIP containing approved videos.');
        return file;
      }
    }
    throw new Error('This file does not appear to be a complete ZIP.');
  }
  if (!files.length || files.length >= 65535 || files.some(file => !file.size || !/\.(mp4|mov|webm|m4v)$/i.test(file.name))) {
    throw new Error('Choose one ZIP or a set of MP4, MOV, WebM or M4V videos.');
  }
  const names = files.map(file => file.name.replace(/[\\/\x00-\x1f]/g, '_'));
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
    throw new Error('Rename duplicate video filenames before packaging them.');
  }
  const total = files.reduce((size, file, index) => size + file.size + 76 + encoder.encode(names[index]).length * 2, 22);
  if (total >= maxSize) throw new Error('This set exceeds the 4 GB ZIP limit. Add a ZIP made in your file manager instead.');
  const chunks = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;

  for (const [index, file] of files.entries()) {
    const filename = encoder.encode(names[index]);
    const crc = await crc32(file);
    const date = new Date(file.lastModified || Date.now());
    const dosDate = ((Math.min(2107, Math.max(1980, date.getFullYear())) - 1980) << 9)
      | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);

    const local = new Uint8Array(30 + filename.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x800, true);
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, file.size, true);
    header.setUint32(22, file.size, true);
    header.setUint16(26, filename.length, true);
    local.set(filename, 30);

    const central = new Uint8Array(46 + filename.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    central.set(local.subarray(4, 30), 6);
    entry.setUint32(42, offset, true);
    central.set(filename, 46);

    chunks.push(local, file);
    directory.push(central);
    offset += local.byteLength + file.size;
    directorySize += central.byteLength;
  }

  const footer = new Uint8Array(22);
  const end = new DataView(footer.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'Flow project';
  return new File([...chunks, ...directory, footer], name + ' - Approved Videos.zip', { type: 'application/zip' });
}

