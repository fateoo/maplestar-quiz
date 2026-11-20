/* Lightweight region discovery on a small preview. Coordinates are preview pixels. */
(() => {
  const MAX_PREVIEW_SIDE = 720;
  const MAX_REFINEMENT_PIXELS = 1_500_000;
  const EDGE_SAMPLES = 24;
  const ALPHA_LIMIT = 96;
  const MATTE = 1;
  const OUTSIDE = 2;
  const VISITED = 3;

  function neutral(red, green, blue) {
    const lightest = Math.max(red, green, blue);
    const spread = lightest - Math.min(red, green, blue);
    return spread <= (lightest <= 38 ? 20 : 12);
  }

  function matteTest(bytes, width, height) {
    const edges = [];
    for (let sample = 0; sample < EDGE_SAMPLES; sample += 1) {
      const x = Math.floor((sample + 0.5) * width / EDGE_SAMPLES);
      const y = Math.floor((sample + 0.5) * height / EDGE_SAMPLES);
      edges.push(x, (height - 1) * width + x, y * width, (y + 1) * width - 1);
    }
    const transparent = position => bytes[4 * position + 3] < ALPHA_LIMIT;
    const minimum = Math.ceil(0.90 * edges.length);
    if (edges.filter(transparent).length >= minimum) return transparent;

    let best = null;
    let bestCount = minimum - 1;
    for (const anchor of edges) {
      if (transparent(anchor)) continue;
      const offset = anchor * 4;
      const red = bytes[offset];
      const green = bytes[offset + 1];
      const blue = bytes[offset + 2];
      if (!neutral(red, green, blue)) continue;
      const matchesWithin = (position, tolerance) => {
        const index = position * 4;
        return bytes[index + 3] < ALPHA_LIMIT || (
          Math.abs(bytes[index] - red) <= tolerance
          && Math.abs(bytes[index + 1] - green) <= tolerance
          && Math.abs(bytes[index + 2] - blue) <= tolerance
        );
      };
      // A uniform pale matte needs less tolerance so the card's highlights do not
      // become connected to its outer padding.
      if (Math.min(red, green, blue) >= 225) {
        const strict = position => matchesWithin(position, 4);
        if (edges.every(strict)) return strict;
      }
      const matches = position => matchesWithin(position, 12);
      const count = edges.filter(matches).length;
      if (count > bestCount) {
        best = matches;
        bestCount = count;
        if (count === edges.length) break;
      }
    }
    return best;
  }

  function brightMatteCard(bytes, width, height, refine) {
    if (bytes[3] < 224 || Math.min(bytes[0], bytes[1], bytes[2]) < 250) return null;
    const matte = position => {
      const offset = position * 4;
      return bytes[offset + 3] >= 224 && Math.abs(bytes[offset] - bytes[0]) <= 4
        && Math.abs(bytes[offset + 1] - bytes[1]) <= 4 && Math.abs(bytes[offset + 2] - bytes[2]) <= 4;
    };
    for (let index = 0; index <= EDGE_SAMPLES; index += 1) {
      const x = Math.floor(index * (width - 1) / EDGE_SAMPLES);
      const y = Math.floor(index * (height - 1) / EDGE_SAMPLES);
      if (![x, (height - 1) * width + x, y * width, (y + 1) * width - 1].every(matte)) return null;
    }

    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    let count = 0;
    const columns = new Uint32Array(width);
    const rows = new Uint32Array(height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (matte(y * width + x)) continue;
        count += 1;
        columns[x] += 1;
        rows[y] += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }

    const w = right - left + 1;
    const h = bottom - top + 1;
    const area = w * h;
    if (left < 2 || top < 2 || right >= width - 2 || bottom >= height - 2 || Math.min(w, h) < 16
      || count < 0.70 * area || area >= width * height * (refine ? 0.98 : 0.78)) return null;
    // A white gap through the envelope is evidence for separate inputs.
    if (columns.subarray(left, right + 1).some(value => value === 0) || rows.subarray(top, bottom + 1).some(value => value === 0)) return null;
    const sides = [0, 0, 0, 0];
    for (let index = 0; index < 20; index += 1) {
      const x = left + Math.floor((index + 0.5) * w / 20);
      const y = top + Math.floor((index + 0.5) * h / 20);
      sides[0] += Number(!matte(top * width + x) || !matte((top + 1) * width + x));
      sides[1] += Number(!matte(bottom * width + x) || !matte((bottom - 1) * width + x));
      sides[2] += Number(!matte(y * width + left) || !matte(y * width + left + 1));
      sides[3] += Number(!matte(y * width + right) || !matte(y * width + right - 1));
    }
    return sides.filter(value => value >= 13).length >= 3 && hasDetail(bytes, width, { left, top, right, bottom })
      ? { x: left, y: top, width: w, height: h, kind: 'card' } : null;
  }

  function markOutside(states, queue, width, height, isMatte) {
    for (let position = 0; position < states.length; position += 1) {
      if (isMatte(position)) states[position] = MATTE;
    }
    let end = 0;
    const enqueue = position => {
      if (states[position] !== MATTE) return;
      states[position] = OUTSIDE;
      queue[end++] = position;
    };
    for (let x = 0; x < width; x += 1) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width);
      enqueue((y + 1) * width - 1);
    }
    for (let head = 0; head < end; head += 1) {
      const position = queue[head];
      const x = position % width;
      if (x > 0) enqueue(position - 1);
      if (x < width - 1) enqueue(position + 1);
      if (position >= width) enqueue(position - width);
      if (position < states.length - width) enqueue(position + width);
    }
    return end;
  }

  function findComponents(states, queue, width, height) {
    const components = [];
    for (let start = 0; start < states.length; start += 1) {
      if (states[start] >= OUTSIDE) continue;
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      let end = 1;
      states[start] = VISITED;
      queue[0] = start;
      for (let head = 0; head < end; head += 1) {
        const position = queue[head];
        const x = position % width;
        const y = (position - x) / width;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row += 1) {
          for (let col = Math.max(0, x - 1); col <= Math.min(width - 1, x + 1); col += 1) {
            const other = row * width + col;
            if (states[other] >= OUTSIDE) continue;
            states[other] = VISITED;
            queue[end++] = other;
          }
        }
      }
      if (end >= 2) components.push({ left, top, right, bottom, count: end });
    }
    return components.sort((a, b) => b.count - a.count || a.top - b.top || a.left - b.left);
  }

  function luminosity(bytes, position) {
    const index = position * 4;
    return (bytes[index] + 2 * bytes[index + 1] + bytes[index + 2]) >> 2;
  }

  function hasDetail(bytes, width, box) {
    const step = Math.max(1, Math.floor(Math.min(box.right - box.left, box.bottom - box.top) / 130));
    const required = Math.max(5, Math.floor((box.right - box.left) * (box.bottom - box.top) / (80 * step * step)));
    let details = 0;
    for (let y = box.top + step; y <= box.bottom - step; y += step) {
      for (let x = box.left + step; x <= box.right - step; x += step) {
        const center = y * width + x;
        const light = 2 * luminosity(bytes, center);
        const dx = Math.abs(luminosity(bytes, center - step) + luminosity(bytes, center + step) - light);
        const dy = Math.abs(luminosity(bytes, center - step * width) + luminosity(bytes, center + step * width) - light);
        if (Math.max(dx, dy) >= 22 && ++details >= required) return true;
      }
    }
    return false;
  }

  function colorDifference(bytes, first, second) {
    const a = first * 4;
    const b = second * 4;
    return Math.abs(bytes[a] - bytes[b]) + Math.abs(bytes[a + 1] - bytes[b + 1]) + Math.abs(bytes[a + 2] - bytes[b + 2]);
  }

  function quietEdges(bytes, states, width, box, minimum = 13, requireMask = true, minimumSides = 4) {
    const { left, top, right, bottom } = box;
    const quiet = (edge, inward) => {
      if (requireMask && (states[edge] !== VISITED || states[inward] !== VISITED)) return false;
      return colorDifference(bytes, edge, inward) <= 64;
    };
    if (requireMask) {
      for (const x of [left + 1, right - 1]) {
        for (const y of [top + 1, bottom - 1]) {
          if (states[y * width + x] !== VISITED) return false;
        }
      }
    }
    const counts = [0, 0, 0, 0];
    for (let index = 0; index < 16; index += 1) {
      const x = left + Math.round((index + 0.5) * (right - left) / 16);
      const y = top + Math.round((index + 0.5) * (bottom - top) / 16);
      counts[0] += quiet((top + 1) * width + x, (top + 3) * width + x);
      counts[1] += quiet((bottom - 1) * width + x, (bottom - 3) * width + x);
      counts[2] += quiet(y * width + left + 1, y * width + left + 3);
      counts[3] += quiet(y * width + right - 1, y * width + right - 3);
    }
    return counts.filter(count => count >= minimum).length >= minimumSides;
  }

  function panelInset(bytes, origin, inward, along, depth, span, backedByMatte) {
    const limit = Math.min(96, Math.floor(depth * 0.18));
    for (let inset = backedByMatte ? 0 : 1; inset <= limit; inset += 1) {
      const offset = origin + inset * inward;
      let transitions = 0;
      let contrast = 0;
      for (let sample = 0; sample < 20; sample += 1) {
        const position = offset + along * Math.floor(span * (0.12 + 0.76 * (sample + 0.5) / 20));
        const difference = colorDifference(bytes, position, position - inward);
        transitions += difference >= 35;
        contrast += Math.min(130, difference);
      }
      if (transitions >= 12 && contrast >= 720) return inset;
    }
    return null;
  }

  function cardBounds(bytes, states, width, height, part, refine) {
    const { left, top, right, bottom, count } = part;
    const w = right - left + 1;
    const h = bottom - top + 1;
    const density = count / (w * h);
    if (Math.min(w, h) < 16 || density < 0.66 || !hasDetail(bytes, width, part)) return null;
    if (density >= 0.91 && quietEdges(bytes, states, width, part)) return part;

    // Shadows can survive the matte flood, while a light scene can lose pixels to it.
    // Look for straight, coherent color steps near the four component boundaries.
    const insets = [
      panelInset(bytes, top * width + left, 1, width, w, h, left > 0),
      panelInset(bytes, top * width + right, -1, width, w, h, right < width - 1),
      panelInset(bytes, top * width + left, width, 1, h, w, top > 0),
      panelInset(bytes, bottom * width + left, -width, 1, h, w, bottom < height - 1),
    ];
    const edgeCount = insets.filter(inset => inset !== null).length;
    if (edgeCount < 3) return null;

    // Small previews can blend the subject into one border. Keep its dense outline
    // here so the full-resolution refinement can decide exactly where to trim it.
    if (!refine && Math.min(w, h) <= 60 && density >= 0.96 && quietEdges(bytes, states, width, part, 11, false, 3)) return part;
    const trimmed = {
      left: left + (insets[0] ?? 0), right: right - (insets[1] ?? 0),
      top: top + (insets[2] ?? 0), bottom: bottom - (insets[3] ?? 0),
    };
    if (Math.min(trimmed.right - trimmed.left, trimmed.bottom - trimmed.top) < 15) return null;
    const quietSideCount = refine && edgeCount < 4 ? 4 : 3;
    return quietEdges(bytes, states, width, trimmed, refine ? 13 : 11, false, quietSideCount) && hasDetail(bytes, width, trimmed)
      ? trimmed : null;
  }

  function separation(a, b) {
    const xGap = Math.max(0, a.left - b.right - 1, b.left - a.right - 1);
    const yGap = Math.max(0, a.top - b.bottom - 1, b.top - a.bottom - 1);
    return xGap + yGap;
  }

  function nearbySmallPart(part, region) {
    if (region.kind !== 'sprite' || part.count > region.core.count * 0.20) return false;
    const core = region.core;
    const margin = Math.max(3, Math.min(20, Math.round(0.14 * Math.min(core.right - core.left, core.bottom - core.top))));
    return separation(part, core) <= margin;
  }

  function clearlySeparate(a, b) {
    if (a.kind === 'card' && b.kind === 'card') return true;
    const shorterSide = Math.min(a.right - a.left + 1, a.bottom - a.top + 1, b.right - b.left + 1, b.bottom - b.top + 1);
    return separation(a, b) >= Math.max(20, shorterSide * 0.65);
  }

  function locateCardRegions(rgba, width, height, options) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4) return [];
    const refine = options?.refine === true;
    const pixels = width * height;
    if (refine ? pixels > MAX_REFINEMENT_PIXELS : Math.max(width, height) > MAX_PREVIEW_SIDE) return [];
    let bytes;
    if (ArrayBuffer.isView(rgba)) bytes = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    else if (Object.prototype.toString.call(rgba) === '[object ArrayBuffer]') bytes = new Uint8Array(rgba);
    else return [];
    if (bytes.length !== pixels * 4) return [];

    const brightCard = brightMatteCard(bytes, width, height, refine);
    if (brightCard) return [brightCard];

    const isMatte = matteTest(bytes, width, height);
    if (!isMatte) return [];
    const states = new Uint8Array(pixels);
    const queue = new Int32Array(pixels);
    const minimumMatte = refine ? 2 * Math.min(width, height) : pixels * 0.30;
    if (markOutside(states, queue, width, height, isMatte) < minimumMatte) return [];

    const components = findComponents(states, queue, width, height);
    const minimum = Math.max(28, Math.floor(pixels * 0.00035));
    const regions = [];
    for (const part of components) {
      const w = part.right - part.left + 1;
      const h = part.bottom - part.top + 1;
      const dense = Math.min(w, h) >= 16 && part.count >= w * h * 0.91;
      const card = cardBounds(bytes, states, width, height, part, refine);
      if (refine && !card) continue;
      const parent = card ? null : regions.find(region => nearbySmallPart(part, region));
      if (parent) {
        parent.left = Math.min(parent.left, part.left);
        parent.top = Math.min(parent.top, part.top);
        parent.right = Math.max(parent.right, part.right);
        parent.bottom = Math.max(parent.bottom, part.bottom);
        continue;
      }
      if (regions.length === 4 || part.count < minimum || Math.min(w, h) < 6 || (dense && !card)) continue;
      regions.push({ ...(card ?? part), core: part, kind: card ? 'card' : 'sprite' });
    }

    // An uncertain split is worse than leaving the full sprite available to the recognizer.
    for (let i = 1; i < regions.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (!clearlySeparate(regions[i], regions[j])) return [];
      }
    }

    const boxes = regions.map(region => {
      const pad = region.kind === 'card' ? 0 : Math.min(8, Math.max(2, Math.round(0.05 * Math.min(region.right - region.left, region.bottom - region.top))));
      const x = Math.max(0, region.left - pad);
      const y = Math.max(0, region.top - pad);
      return {
        x, y, width: Math.min(width, region.right + pad + 1) - x,
        height: Math.min(height, region.bottom + pad + 1) - y, kind: region.kind,
      };
    });
    if (refine) return boxes.length === 1 ? boxes : [];
    if (boxes.length === 1 && boxes[0].width * boxes[0].height >= pixels * 0.40) return [];
    return boxes;
  }

  globalThis.locateCardRegions = locateCardRegions;
})();
