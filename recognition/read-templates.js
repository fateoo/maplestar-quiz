async function* readMapleTemplates(entries, compressed) {
  function decodeBase64(value) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(value);
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  }

  const blockSize = 256 * 1024;
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= compressed.length) {
        controller.close();
        return;
      }
      controller.enqueue(decodeBase64(compressed.slice(offset, offset + blockSize)));
      offset += blockSize;
    },
  });

  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader();
  let chunk = new Uint8Array(0);
  let position = 0;

  async function take(size) {
    if (chunk.length - position >= size) {
      const result = chunk.subarray(position, position + size);
      position += size;
      return result;
    }
    const buffer = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (position === chunk.length) {
        const next = await reader.read();
        if (next.done) throw new Error('圖鑑資料不完整，請重新建立圖鑑。');
        chunk = next.value;
        position = 0;
      }
      const length = Math.min(size - filled, chunk.length - position);
      buffer.set(chunk.subarray(position, position + length), filled);
      position += length;
      filled += length;
    }
    return buffer;
  }

  try {
    for (const entry of entries) {
      const [count] = await take(1);
      const templates = [];
      for (let index = 0; index < count; index += 1) {
        const header = await take(4);
        const width = header[0] | (header[1] << 8);
        const height = header[2] | (header[3] << 8);
        templates.push({ width, height, rgba: await take(width * height * 4) });
      }
      yield { ...entry, templates };
    }
    const remaining = await reader.read();
    if (!remaining.done || position !== chunk.length) {
      throw new Error('圖鑑與索引的版本不符，請重新建立圖鑑。');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

globalThis.readMapleTemplates = readMapleTemplates;
