/* Versioned binary feature pack. The matching encoder is compile-index.cjs. */
async function* readMapleIndex(entries, compressed) {
  let data;
  if (typeof Uint8Array.fromBase64 === 'function') {
    data = Uint8Array.fromBase64(compressed);
  } else {
    const decoded = atob(compressed);
    data = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) data[index] = decoded.charCodeAt(index);
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  const view = new DataView(buffer);
  let position = 0;

  function u8() {
    return view.getUint8(position++);
  }

  function i8() {
    return view.getInt8(position++);
  }

  function u16() {
    const value = view.getUint16(position, true);
    position += 2;
    return value;
  }

  function u32() {
    const value = view.getUint32(position, true);
    position += 4;
    return value;
  }

  function i16() {
    const value = view.getInt16(position, true);
    position += 2;
    return value;
  }

  function f64() {
    const value = view.getFloat64(position, true);
    position += 8;
    return value;
  }

  function list(count, read) {
    const items = new Array(count);
    for (let index = 0; index < count; index += 1) items[index] = read();
    return items;
  }

  function coordinates() {
    return { x: u16(), y: u16() };
  }

  function point() {
    return { x: u16(), y: u16(), pixel: u32(), light: u8() };
  }

  function anchor() {
    return { ...point(), penalty: f64() };
  }

  function edge() {
    const { x, y } = coordinates();
    return { x, y, outsideX: x + i8(), outsideY: y + i8() };
  }

  function pair() {
    return { a: coordinates(), b: coordinates(), difference: i16() };
  }

  function frame() {
    const width = u16();
    const height = u16();
    const paletteSize = u16();
    const darkSilhouette = u8() !== 0;
    const anchorCount = u8();
    const sampleCount = u8();
    const contourCount = u8();
    const gradientCount = u8();
    const contrastCount = u8();
    const silhouette = new Uint8Array(buffer, position, 144);
    position += silhouette.length;
    return {
      width, height, paletteSize, darkSilhouette, silhouette,
      anchors: list(anchorCount, anchor),
      samples: list(sampleCount, point),
      contour: list(contourCount, edge),
      gradients: list(gradientCount, pair),
      contrast: list(contrastCount, pair),
    };
  }

  if (u32() !== 0x5844494d || u8() !== 1 || u32() !== entries.length) {
    throw new Error('圖鑑與辨識索引的版本不符，請重新建立圖鑑。');
  }
  const frames = list(u32(), frame);
  for (const entry of entries) {
    if (u32() !== Number(entry.id) || u8() !== Number(entry.type === 'npc')) {
      throw new Error('圖鑑條目與辨識索引不符，請重新建立圖鑑。');
    }
    const preparedFrames = list(u8(), () => {
      const item = frames[u32()];
      if (!item) throw new Error('圖鑑的辨識索引不完整。');
      return item;
    });
    yield { ...entry, preparedFrames };
  }
  if (position !== buffer.byteLength) throw new Error('圖鑑的辨識索引長度有誤。');
}

globalThis.readMapleIndex = readMapleIndex;
