/* A classic script so the app can construct a Blob worker from a file:// page. */
function mapleRecognitionWorker(onPrepared) {
  const JPEG_BUCKET_COUNT = 32 * 16 * 16;
  const COMMON_SCALES = [1, 2];
  const EXTRA_SCALES = [1.5, 1.25, 0.75, 0.5, 3];
  const JPEG_EXTRA_SCALES = [1.5, 1.25];
  const MAX_SCREEN_PIXELS = 8_500_000;
  const MAX_LEAD_POSITIONS = 16_000;
  const MAX_JPEG_LEAD_POSITIONS = 2_400;
  const SCORE_FLOOR = 0.80;
  const SUBJECT_CANDIDATE_LIMIT = 5;
  const SUBJECT_SCORE_RANGE = 0.12;
  const SIGNATURE_SIDE = 12;
  const EDGE_STEP_X = [-1, 1, 0, 0];
  const EDGE_STEP_Y = [0, 0, -1, 1];
  let templates = [];
  let translucentTemplates = [];
  let logicalTemplateCount = 0;
  const matchGeometry = new WeakMap();
  let exactColors = new Map();

  function byteArray(rgba) {
    if (typeof rgba === 'string') {
      if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(rgba);
      const decoded = atob(rgba);
      return Uint8Array.from(decoded, character => character.charCodeAt(0));
    }
    if (rgba instanceof ArrayBuffer) return new Uint8Array(rgba);
    if (ArrayBuffer.isView(rgba)) return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    throw new Error('缺少 RGBA 像素資料。');
  }

  function pixelWords(bytes) {
    const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  }

  function rgbError(a, b) {
    return Math.abs((a & 255) - (b & 255))
      + Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255))
      + Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255));
  }

  function luminance(pixel) {
    return (77 * (pixel & 255) + 150 * ((pixel >>> 8) & 255) + 29 * ((pixel >>> 16) & 255)) >> 8;
  }

  function screenedError(screen, index, point) {
    const actual = screen.pixels[index];
    if (!screen.approximate) return rgbError(actual, point.pixel);
    return 2 * Math.abs(screen.lightValues[index] - point.light) + rgbError(actual, point.pixel) / 3;
  }

  function colorKey(pixel) {
    return ((pixel & 240) << 4) | ((pixel >>> 8) & 240) | ((pixel >>> 20) & 15);
  }

  function jpegKey(pixel, light) {
    const green = (pixel >>> 8) & 255;
    const redChroma = (255 + (pixel & 255) - green) >> 1;
    const blueChroma = (255 + ((pixel >>> 16) & 255) - green) >> 1;
    return ((light >> 3) << 8) | ((redChroma >> 4) << 4) | (blueChroma >> 4);
  }

  function neighboringKeys(pixel) {
    const red = pixel & 255;
    const green = (pixel >>> 8) & 255;
    const blue = (pixel >>> 16) & 255;
    const light = luminance(pixel);
    const redChroma = (255 + red - green) >> 1;
    const blueChroma = (255 + blue - green) >> 1;
    const keys = [];
    for (let l = Math.max(0, light - 6) >> 3; l <= Math.min(255, light + 6) >> 3; l += 1) {
      for (let r = Math.max(0, redChroma - 10) >> 4; r <= Math.min(255, redChroma + 10) >> 4; r += 1) {
        for (let b = Math.max(0, blueChroma - 10) >> 4; b <= Math.min(255, blueChroma + 10) >> 4; b += 1) {
          keys.push((l << 8) | (r << 4) | b);
        }
      }
    }
    return Uint16Array.from(keys);
  }

  function templatePoint(point, bounds, pixels) {
    const pixel = pixels[point.offset];
    return { x: point.x - bounds.left, y: point.y - bounds.top, pixel, light: luminance(pixel) };
  }

  function registerAnchor(anchor) {
    const rgb = anchor.pixel & 0xffffff;
    if (!exactColors.has(rgb)) exactColors.set(rgb, exactColors.size);
    anchor.exactKey = exactColors.get(rgb);
    return anchor;
  }

  function addRuntimeFeatures(template) {
    template.quickAnchors = takeSpread(template.anchors, 10);
    template.translucent = template.samples.every(point => (point.pixel >>> 24) < 224);
    let left = template.width;
    let top = template.height;
    let right = -1;
    let bottom = -1;
    for (const point of [...template.samples, ...template.anchors]) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    const width = right - left + 1;
    const height = bottom - top + 1;
    if (width >= 6 && height >= 6 && (width < 0.88 * template.width || height < 0.88 * template.height)) {
      template.probeBounds = { x: left, y: top, width, height };
    }
    return template;
  }

  function shapeSignature(pixels, stride, box, isForeground) {
    const signature = new Uint8Array(SIGNATURE_SIDE ** 2);
    const steps = SIGNATURE_SIDE * 2;
    for (let row = 0; row < steps; row += 1) {
      const y = box.y + Math.floor((row + 0.5) * box.height / steps);
      for (let column = 0; column < steps; column += 1) {
        const x = box.x + Math.floor((column + 0.5) * box.width / steps);
        if (isForeground(pixels[y * stride + x])) {
          signature[(row >> 1) * SIGNATURE_SIDE + (column >> 1)] += 1;
        }
      }
    }
    return signature;
  }

  function isVisible(pixel) {
    return (pixel >>> 24) >= 96;
  }

  function contrastPairs(samples, width, height) {
    const pairs = [];
    for (const a of takeSpread(samples, 21)) {
      let best;
      for (const b of samples) {
        const distance = Math.abs(a.x - b.x) / width + Math.abs(a.y - b.y) / height;
        const difference = a.light - b.light;
        if (distance < 0.045 || distance > 0.22 || Math.abs(difference) < 48) continue;
        if (!best || Math.abs(difference) > Math.abs(best.difference)) best = { a, b, difference };
      }
      if (best) pairs.push(best);
    }
    return pairs;
  }

  function compactTemplate(frame, entry) {
    const { width, height } = frame;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) return null;
    const rgba = byteArray(frame.rgba);
    if (rgba.length !== width * height * 4) return null;
    const pixels = pixelWords(rgba);
    const bounds = { left: width, top: height, right: -1, bottom: -1 };
    let foregroundCount = 0;
    let opaqueCount = 0;
    for (let offset = 0; offset < pixels.length; offset += 1) {
      const alpha = pixels[offset] >>> 24;
      if (alpha < 96) continue;
      const x = offset % width;
      const y = Math.floor(offset / width);
      foregroundCount += 1;
      if (alpha >= 224) opaqueCount += 1;
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
    if (foregroundCount < 24) return null;

    const templateWidth = bounds.right - bounds.left + 1;
    const templateHeight = bounds.bottom - bounds.top + 1;
    if (templateWidth < 6 || templateHeight < 6) return null;
    const alphaMin = opaqueCount >= Math.min(foregroundCount * 0.3, 100) ? 224 : 96;
    const sampleCount = alphaMin === 224 ? opaqueCount : foregroundCount;
    const sampleStride = Math.max(1, sampleCount / 128);
    const grid = Array(25);
    const palette = new Map();
    const samples = [];
    const edges = [];
    const gradients = [];
    let sampledAt = Math.floor(sampleStride / 2);
    let sampleIndex = 0;
    const anchorStride = Math.max(1, Math.floor(sampleCount / 2400));
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
      for (let x = bounds.left; x <= bounds.right; x += 1) {
        const offset = y * width + x;
        const pixel = pixels[offset];
        if ((pixel >>> 24) < alphaMin) continue;
        sampleIndex += 1;
        const needsSample = sampleIndex - 1 >= sampledAt;
        if (!needsSample && sampleIndex % anchorStride !== 0) continue;
        const point = { x, y, offset };
        if (needsSample) {
          const sample = templatePoint(point, bounds, pixels);
          samples.push(sample);
          let strongest;
          for (let side = 0; side < 4; side += 1) {
            const neighborX = x + 2 * EDGE_STEP_X[side];
            const neighborY = y + 2 * EDGE_STEP_Y[side];
            if (neighborX < bounds.left || neighborY < bounds.top || neighborX > bounds.right || neighborY > bounds.bottom) continue;
            const pixelB = pixels[neighborY * width + neighborX];
            if ((pixelB >>> 24) < alphaMin) continue;
            const difference = luminance(pixel) - luminance(pixelB);
            if (Math.abs(difference) < 32 || (strongest && Math.abs(strongest.difference) >= Math.abs(difference))) continue;
            strongest = { a: sample, b: { x: neighborX - bounds.left, y: neighborY - bounds.top }, difference };
          }
          if (strongest) gradients.push(strongest);
          sampledAt += sampleStride;
        }
        let instability = 0;
        let edgeCount = 0;
        for (let side = 0; side < 4; side += 1) {
          const neighborX = x + EDGE_STEP_X[side];
          const neighborY = y + EDGE_STEP_Y[side];
          const outside = neighborX < 0 || neighborY < 0 || neighborX === width || neighborY === height;
          const neighbor = outside ? 0 : pixels[neighborY * width + neighborX];
          if ((neighbor >>> 24) < 96) {
            edgeCount += 1;
            edges.push({
              x: x - bounds.left, y: y - bounds.top,
              outsideX: neighborX - bounds.left, outsideY: neighborY - bounds.top,
            });
          } else {
            instability += rgbError(pixel, neighbor);
          }
        }
        const gridX = (x - bounds.left + 0.5) * 5 / templateWidth;
        const gridY = (y - bounds.top + 0.5) * 5 / templateHeight;
        const cellX = Math.floor(gridX);
        const cellY = Math.floor(gridY);
        const cell = cellY * 5 + cellX;
        point.penalty = instability + 110 * edgeCount
          + 20 * (Math.abs(gridX - cellX - 0.5) + Math.abs(gridY - cellY - 0.5));
        if (!grid[cell] || point.penalty < grid[cell].penalty) grid[cell] = point;

        const key = colorKey(pixel);
        const color = palette.get(key);
        if (color) {
          color.count += 1;
          if (point.penalty < color.best.penalty) color.best = point;
        } else {
          palette.set(key, { count: 1, best: point });
        }
      }
    }

    const anchorPoints = new Map(grid.filter(Boolean).map(point => [point.offset, point]));
    const stableColors = [...palette.values()]
      .filter(color => color.count >= Math.min(4, sampleCount / 25))
      .sort((a, b) => a.best.penalty - b.best.penalty || a.count - b.count)
      .slice(0, 12);
    for (const { best } of stableColors) anchorPoints.set(best.offset, best);
    const anchors = [...anchorPoints.values()].map(point => {
      const anchor = templatePoint(point, bounds, pixels);
      anchor.penalty = point.penalty;
      return registerAnchor(anchor);
    });
    if (anchors.length < 3) return null;
    const contour = takeSpread(edges, 28);
    let totalLight = 0;
    let totalChroma = 0;
    for (const sample of samples) {
      const red = sample.pixel & 255;
      const green = (sample.pixel >>> 8) & 255;
      const blue = (sample.pixel >>> 16) & 255;
      totalLight += sample.light;
      totalChroma += Math.max(red, green, blue) - Math.min(red, green, blue);
    }
    return {
      entry, width: templateWidth, height: templateHeight, anchors, samples, contour,
      gradients: takeSpread(gradients, 24), paletteSize: palette.size,
      contrast: contrastPairs(samples, templateWidth, templateHeight),
      darkSilhouette: totalLight < samples.length * 20 && totalChroma < samples.length * 12,
      silhouette: shapeSignature(pixels, width, {
        x: bounds.left, y: bounds.top, width: templateWidth, height: templateHeight,
      }, isVisible),
    };
  }

  function takeSpread(values, limit) {
    if (values.length <= limit) return values;
    return Array.from({ length: limit }, (_, index) => values[Math.floor((index + 0.5) * values.length / limit)]);
  }

  function screenshotPixels(rgba, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
      || width * height > MAX_SCREEN_PIXELS) throw new Error('截圖尺寸無效或過大。');
    const bytes = byteArray(rgba);
    if (bytes.length !== width * height * 4) throw new Error('截圖像素資料不完整。');
    return pixelWords(bytes);
  }

  function indexScreen(rgba, width, height, approximate) {
    const pixels = screenshotPixels(rgba, width, height);
    const offsets = new Uint32Array((approximate ? JPEG_BUCKET_COUNT : exactColors.size) + 1);
    const keys = new Uint32Array(pixels.length);
    const lightValues = approximate ? new Uint8Array(pixels.length) : null;
    for (let position = 0; position < pixels.length; position += 1) {
      const pixel = pixels[position];
      let key;
      if (approximate) {
        const light = luminance(pixel);
        lightValues[position] = light;
        key = jpegKey(pixel, light);
      } else {
        key = exactColors.get(pixel & 0xffffff);
      }
      if (key === undefined) continue;
      keys[position] = key + 1;
      offsets[key + 1] += 1;
    }
    for (let key = 1; key < offsets.length; key += 1) offsets[key] += offsets[key - 1];
    const next = offsets.slice();
    const positions = new Uint32Array(offsets[offsets.length - 1]);
    for (let position = 0; position < keys.length; position += 1) {
      const key = keys[position];
      if (key !== 0) positions[next[key - 1]++] = position;
    }
    const leadBudget = approximate
      ? Math.min(MAX_JPEG_LEAD_POSITIONS, Math.max(350, Math.floor(10_000_000 / logicalTemplateCount)))
      : MAX_LEAD_POSITIONS;
    return { width, height, pixels, offsets, positions, approximate, lightValues, leadBudget };
  }

  function candidateLeads(template, screen) {
    let first = null;
    let second = null;
    let presentCount = 0;
    const lossyLeads = [];
    for (const [anchorIndex, anchor] of template.anchors.entries()) {
      let count = 0;
      if (screen.approximate) {
        anchor.keys ??= neighboringKeys(anchor.pixel);
        for (const approximateKey of anchor.keys) count += screen.offsets[approximateKey + 1] - screen.offsets[approximateKey];
      } else {
        const key = anchor.exactKey;
        count = screen.offsets[key + 1] - screen.offsets[key];
      }
      if (!count) continue;
      presentCount += 1;
      if (screen.approximate) {
        // A flat interior color survives JPEG better than a rarer outline color.
        const cost = (count + 30) * (1 + (anchor.penalty / 38) ** 2);
        lossyLeads.push({ anchor, anchorIndex, count, cost });
        continue;
      }
      if (!first || count < first.count) {
        if (!first || rgbError(anchor.pixel, first.anchor.pixel) >= 24) second = first;
        first = { anchor, anchorIndex, count };
      } else if ((!second || count < second.count) && rgbError(anchor.pixel, first.anchor.pixel) >= 24) {
        second = { anchor, anchorIndex, count };
      }
    }
    if (presentCount < template.anchors.length * 0.43) return [];
    if (screen.approximate) {
      lossyLeads.sort((a, b) => a.cost - b.cost);
      const leads = [];
      let budget = screen.leadBudget;
      for (const lead of lossyLeads) {
        if (leads.length && lead.count > budget) continue;
        if (leads.some(other => rgbError(other.anchor.pixel, lead.anchor.pixel) < 12
          && Math.abs(other.anchor.x - lead.anchor.x) + Math.abs(other.anchor.y - lead.anchor.y) < 6)) continue;
        leads.push(lead);
        budget -= lead.count;
        if (leads.length === 6 || budget <= 0) break;
      }
      return leads;
    }
    if (second && rgbError(second.anchor.pixel, first.anchor.pixel) < 24) second = null;
    if (!second || first.count > 70 || second.count > 800) return first ? [first] : [];
    return [first, second];
  }

  function scaledCoordinate(coordinate, scale) {
    return Math.round((coordinate + 0.5) * scale - 0.5);
  }

  function transform(template, scale, mirrored, screenWidth) {
    const width = Math.round(template.width * scale);
    const height = Math.round(template.height * scale);
    const scaleX = coordinate => mirrored ? width - 1 - scaledCoordinate(coordinate, scale) : scaledCoordinate(coordinate, scale);
    const scaleY = coordinate => scaledCoordinate(coordinate, scale);
    const expand = point => {
      const x = scaleX(point.x);
      const y = scaleY(point.y);
      return { x, y, offset: y * screenWidth + x, pixel: point.pixel, light: point.light };
    };
    const anchors = template.anchors.map(expand);
    const view = { width, height, anchors, mirrored };
    return {
      ...view,
      get samples() {
        view.samples ??= template.samples.map(expand);
        return view.samples;
      },
      get contour() {
        view.contour ??= template.contour.map(point => {
          const deltaX = point.outsideX - point.x;
          const deltaY = point.outsideY - point.y;
          const edgeX = Math.round(Math.max(point.x, point.outsideX) * scale);
          const edgeY = Math.round(Math.max(point.y, point.outsideY) * scale);
          const innerX = deltaX ? edgeX - Number(deltaX > 0) : scaledCoordinate(point.x, scale);
          const x = mirrored ? width - 1 - innerX : innerX;
          const y = deltaY ? edgeY - Number(deltaY > 0) : scaleY(point.y);
          return { x, y, outsideX: x + (mirrored ? -deltaX : deltaX), outsideY: y + deltaY };
        });
        return view.contour;
      },
      get gradients() {
        view.gradients ??= template.gradients.map(({ a, b, difference }) => ({
          a: expand(a).offset, b: expand(b).offset, difference,
        }));
        return view.gradients;
      },
    };
  }

  function guardIndices(view, leadIndex) {
    const { anchors, width, height } = view;
    const lead = anchors[leadIndex];
    const xWeight = 70 / width;
    const yWeight = 70 / height;
    const guards = [];
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index];
      if (anchor.offset === lead.offset) continue;
      const distance = Math.abs(anchor.x - lead.x) * xWeight
        + Math.abs(anchor.y - lead.y) * yWeight + rgbError(anchor.pixel, lead.pixel) * 0.25;
      guards.push({ index, distance });
    }
    guards.sort((a, b) => b.distance - a.distance);
    return [...guards.slice(0, 3), ...takeSpread(guards.slice(3), 9)].map(guard => guard.index);
  }

  function needsContour(template) {
    return template.paletteSize < 3 && template.gradients.length === 0;
  }

  function verify(screen, view, template, x, y, jpeg) {
    const topLeft = y * screen.width + x;
    const inlierError = jpeg ? 65 : 49;
    const cap = jpeg ? 212 : 133;
    let deviation = 0;
    let inliers = 0;
    let mismatches = 0;
    const { samples } = view;
    const maximumMismatches = Math.floor(samples.length * 0.27);
    for (const sample of samples) {
      const error = screenedError(screen, topLeft + sample.offset, sample);
      deviation += Math.min(error, cap);
      if (error <= inlierError) inliers += 1;
      else if (++mismatches > maximumMismatches) return 0;
    }
    const inlierRatio = inliers / samples.length;
    const colorScore = 0.66 * inlierRatio + 0.34 * (1 - deviation / (cap * samples.length));
    if (colorScore < SCORE_FLOOR) return 0;

    if (jpeg && view.gradients.length >= 8) {
      let gradientMatches = 0;
      for (const gradient of view.gradients) {
        const actual = screen.lightValues[topLeft + gradient.a] - screen.lightValues[topLeft + gradient.b];
        if (Math.sign(gradient.difference) * actual >= Math.abs(gradient.difference) * 0.4) gradientMatches += 1;
      }
      if (gradientMatches < view.gradients.length * 0.58) return 0;
    }

    let edgeCount = 0;
    let visibleEdges = 0;
    for (const edge of view.contour) {
      const outsideX = x + edge.outsideX;
      const outsideY = y + edge.outsideY;
      if (outsideX < 0 || outsideY < 0 || outsideX >= screen.width || outsideY >= screen.height
        || edge.x < 0 || edge.y < 0 || edge.x >= view.width || edge.y >= view.height) continue;
      edgeCount += 1;
      const inside = screen.pixels[topLeft + edge.y * screen.width + edge.x];
      const outside = screen.pixels[outsideY * screen.width + outsideX];
      if (rgbError(inside, outside) >= 27) visibleEdges += 1;
    }
    if (edgeCount < 6) return needsContour(template) ? 0 : colorScore;
    const edgeRatio = visibleEdges / edgeCount;
    if (edgeRatio < (template.paletteSize < 7 ? 0.25 : 0.15)) return 0;
    return colorScore * (0.94 + 0.06 * edgeRatio);
  }

  function overlaps(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (width <= 0 || height <= 0) return false;
    return width * height >= 0.63 * Math.min(a.width * a.height, b.width * b.height);
  }

  function sameName(first, second) {
    return first.type === second.type && (first.id === second.id || first.name === second.name);
  }

  function matchFromTemplate(template, position, score, method, mirrored) {
    const match = { ...template.entry, ...position, score };
    if (method) match.method = method;
    if (template.aliases?.length) {
      match.alternatives = template.aliases.map(entry => ({ ...entry, ...position, score }));
    }
    matchGeometry.set(match, { template, mirrored });
    return match;
  }

  function recordPosition(matches, match, limit) {
    const duplicate = matches.findIndex(other => overlaps(other, match));
    if (duplicate !== -1) {
      if (matches[duplicate].score < match.score) matches[duplicate] = match;
    } else if (matches.length < limit) {
      matches.push(match);
    } else {
      let weakest = 0;
      for (let index = 1; index < matches.length; index += 1) {
        if (matches[index].score < matches[weakest].score) weakest = index;
      }
      if (match.score > matches[weakest].score) matches[weakest] = match;
    }
  }

  function scanLead(template, view, screen, leadInfo, orderedGuards, options, matches) {
    const lead = view.anchors[leadInfo.anchorIndex];
    const guards = orderedGuards.map(index => view.anchors[index]);
    const maxX = screen.width - view.width;
    const maxY = screen.height - view.height;
    const stride = Math.max(1, Math.ceil(leadInfo.count / screen.leadBudget));
    const guardError = options.jpeg ? 87 : 68;
    const allowedMisses = Math.floor(guards.length * (options.jpeg ? 0.42 : 0.33));
    const keys = screen.approximate ? leadInfo.anchor.keys : [leadInfo.anchor.exactKey];
    const { width: screenWidth } = screen;
    const finalOffset = (view.height - 1) * screenWidth + view.width - 1;
    const lastTopLeft = screen.pixels.length - 1 - finalOffset;
    for (const key of keys) {
      const end = screen.offsets[key + 1];
      candidate: for (let index = screen.offsets[key]; index < end; index += stride) {
        const position = screen.positions[index];
        const topLeft = position - lead.offset;
        if (topLeft < 0 || topLeft > lastTopLeft) continue;
        if (screen.approximate && screenedError(screen, position, lead) > 38) continue;
        let misses = 0;
        let closeGuard = false;
        for (let guardIndex = 0; guardIndex < guards.length; guardIndex += 1) {
          const guard = guards[guardIndex];
          const error = screenedError(screen, topLeft + guard.offset, guard);
          if (error > guardError) misses += 1;
          if (error <= 38) closeGuard = true;
          if (misses > allowedMisses || (guardIndex === 2 && !closeGuard)) continue candidate;
        }
        const y = Math.floor(topLeft / screenWidth);
        const x = topLeft - y * screenWidth;
        if (x > maxX || y > maxY) continue;
        const score = verify(screen, view, template, x, y, options.jpeg);
        if (score < SCORE_FLOOR || (options.rejectWeakDark && template.darkSilhouette && score < 0.94)) continue;
        const bounds = { x, y, width: view.width, height: view.height };
        recordPosition(matches, matchFromTemplate(template, bounds, score, 'spatial', view.mirrored), options.limit);
      }
    }
  }

  function recognize(screen, options) {
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(30, options.limit)) : 10;
    const explicitScale = Number(options.scale);
    if (Number.isFinite(explicitScale) && (explicitScale < 0.35 || explicitScale > 4)) throw new Error('縮放倍率須介於 0.35 到 4 之間。');
    const candidates = [];
    const matchOptions = { limit, jpeg: screen.approximate, rejectWeakDark: options.rejectWeakDark === true };
    const minScale = Number.isFinite(explicitScale) ? explicitScale : screen.approximate ? 1 : 0.5;
    const maxScale = Number.isFinite(explicitScale) ? explicitScale : screen.approximate ? 2 : 3;
    const search = [];
    for (const template of templates) {
      if (options.entityType && options.entityType !== template.entry.type) continue;
      // A dark grayscale silhouette can match almost any shadow in the lossy pass.
      if (screen.approximate && template.darkSilhouette) continue;
      if (needsContour(template) && template.contour.length < 6) continue;
      if (Math.round(template.width * minScale) > screen.width || Math.round(template.height * minScale) > screen.height
        || Math.round(template.width * maxScale) < 5 || Math.round(template.height * maxScale) < 5) continue;
      const leads = candidateLeads(template, screen);
      if (leads.length) search.push({ template, leads });
    }
    function scanScales(scales) {
      for (const { template, leads } of search) {
        const matches = [];
        for (const scale of scales) {
          const width = Math.round(template.width * scale);
          const height = Math.round(template.height * scale);
          if (width < 5 || height < 5 || width > screen.width || height > screen.height) continue;
          const normal = transform(template, scale, false, screen.width);
          const mirrored = transform(template, scale, true, screen.width);
          for (const lead of leads) {
            // Mirroring preserves the distances used to choose guard pixels.
            const guards = guardIndices(normal, lead.anchorIndex);
            scanLead(template, normal, screen, lead, guards, matchOptions, matches);
            scanLead(template, mirrored, screen, lead, guards, matchOptions, matches);
          }
        }
        candidates.push(...matches);
      }
    }
    if (Number.isFinite(explicitScale)) scanScales([explicitScale]);
    else {
      scanScales(COMMON_SCALES);
      const confidenceThreshold = screen.approximate ? 0.83 : 0.9;
      if (!candidates.some(match => match.score >= confidenceThreshold)) {
        scanScales(screen.approximate ? JPEG_EXTRA_SCALES : EXTRA_SCALES);
      }
    }
    return rankMatches(candidates, limit, options.includeSubjectAlternates);
  }

  function compareMatches(a, b) {
    return b.score - a.score || (b.width * b.height) - (a.width * a.height);
  }

  function rankMatches(candidates, limit, includeSubjectAlternates = false) {
    candidates.sort(compareMatches);
    const tolerance = includeSubjectAlternates ? SUBJECT_SCORE_RANGE : 0.025;
    const alternateLimit = includeSubjectAlternates ? 12 : 3;
    const sameAnswer = includeSubjectAlternates ? (a, b) => answerName(a) === answerName(b) : sameName;
    const matches = [];
    for (const candidate of candidates) {
      const duplicate = matches.find(other => overlaps(other, candidate));
      if (!duplicate && matches.length < limit) {
        matches.push(candidate);
      } else if (duplicate && candidate.score >= duplicate.score - tolerance) {
        const alternatives = duplicate.alternatives ?? [];
        for (const alternative of [candidate, ...(candidate.alternatives ?? [])]) {
          if (alternatives.length >= alternateLimit) break;
          if (sameAnswer(alternative, duplicate) || alternatives.some(other => sameAnswer(other, alternative))) continue;
          alternatives.push(alternative);
        }
        if (alternatives.length) duplicate.alternatives = alternatives;
      }
    }
    return matches;
  }

  function answerName(entry) {
    return String(entry.name_zh_tw || entry.name || `編號 ${entry.id}`)
      .normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function rankSubject(candidates, limit, acceptScore, alternateScore, verified = null) {
    const canLead = candidate => candidate.score >= acceptScore || candidate === verified;
    if (limit === 1) return rankMatches(candidates.filter(canLead), 1);
    candidates.sort(compareMatches);
    const primary = candidates.find(canLead);
    if (!primary) return [];

    const primaryArea = primary.width * primary.height;
    const scoreFloor = Math.max(alternateScore, primary.score - SUBJECT_SCORE_RANGE);
    const nearby = [];
    for (const candidate of candidates) {
      if (candidate.score < scoreFloor) break;
      for (const alternative of [candidate, ...(candidate.alternatives ?? [])]) {
        const area = alternative.width * alternative.height;
        if (Math.min(area, primaryArea) < 0.5 * Math.max(area, primaryArea) || !overlaps(primary, alternative)) continue;
        nearby.push(alternative);
      }
    }
    nearby.sort(compareMatches);
    const names = new Set();
    const matches = [];
    for (const candidate of [primary, ...nearby]) {
      if (candidate !== primary && (candidate.score < scoreFloor || candidate.score > primary.score)) continue;
      const name = answerName(candidate);
      if (names.has(name)) continue;
      names.add(name);
      const { alternatives, ...result } = candidate;
      matches.push(result);
      if (matchGeometry.has(candidate)) matchGeometry.set(result, matchGeometry.get(candidate));
      if (matches.length === limit) break;
    }
    return matches;
  }

  function subjectAppearance(screen, template, box, clip, mirrored, shape) {
    const scaleX = box.width / template.width;
    const scaleY = box.height / template.height;
    const radius = Math.max(1, Math.min(3, Math.round(scaleX)));
    const clipRight = clip.x + clip.width;
    const clipBottom = clip.y + clip.height;
    const coordinateX = point => box.x + Math.floor((mirrored ? template.width - point.x - 0.5 : point.x + 0.5) * scaleX);
    const coordinateY = point => box.y + Math.floor((point.y + 0.5) * scaleY);
    const visible = (x, y) => x >= clip.x && y >= clip.y && x < clipRight && y < clipBottom;
    const probes = takeSpread(template.samples, 28);
    let hits = 0;
    let seen = 0;
    let errorSum = 0;
    for (const probe of probes) {
      const x = coordinateX(probe);
      const y = coordinateY(probe);
      if (!visible(x, y)) continue;
      let error = screenedError(screen, y * screen.width + x, probe);
      if (error > 42) {
        for (let side = 0; side < 4; side += 1) {
          const nearX = x + radius * EDGE_STEP_X[side];
          const nearY = y + radius * EDGE_STEP_Y[side];
          if (visible(nearX, nearY)) error = Math.min(error, 12 + screenedError(screen, nearY * screen.width + nearX, probe));
        }
      }
      hits += Number(error <= 100);
      errorSum += Math.min(160, error);
      seen += 1;
    }
    if (seen < probes.length * 0.81 || hits < seen * 0.35) return 0;

    let checked = 0;
    let correct = 0;
    for (const { a, b, difference } of template.contrast) {
      const x1 = coordinateX(a);
      const x2 = coordinateX(b);
      const y1 = coordinateY(a);
      const y2 = coordinateY(b);
      if (!visible(x1, y1) || !visible(x2, y2) || (x1 === x2 && y1 === y2)) continue;
      const actual = screen.lightValues[y1 * screen.width + x1] - screen.lightValues[y2 * screen.width + x2];
      checked += 1;
      if (Math.sign(difference) * actual >= Math.abs(difference) * 0.22) correct += 1;
    }
    const agreement = 0.48 * hits / seen + 0.52 * (1 - errorSum / (160 * seen));
    const contrast = checked >= 8 ? correct / checked : shape;
    if (hits >= seen * 0.64 && (checked >= 8 ? contrast >= 0.36 : shape >= 0.76)) {
      return 0.54 * agreement + 0.33 * shape + 0.13 * contrast;
    }
    // Variants can repaint the same body or replace equipment without changing the silhouette.
    if ((shape >= 0.80 && contrast >= 0.50) || (shape >= 0.76 && hits >= seen * 0.39)) {
      return 0.55 * shape + 0.35 * agreement + 0.10 * contrast;
    }
    return 0;
  }

  function completeSubject(source, subject, options, matches, limit) {
    if (!matches.length || matches.length >= limit) return matches;
    const primary = matches[0];
    if (options.suggestions && primary.score < SCORE_FLOOR) return matches;
    const geometry = matchGeometry.get(primary);
    if (!geometry) return matches;

    source.lightValues ??= Uint8Array.from(source.pixels, luminance);
    const screen = { ...source, approximate: true };
    const names = new Set(matches.map(answerName));
    const box = { x: primary.x, y: primary.y, width: primary.width, height: primary.height };
    const clip = primary.method === 'normalized' && subject ? subject.box : { x: 0, y: 0, width: screen.width, height: screen.height };
    const { template: reference, mirrored: referenceMirrored } = geometry;
    const minimum = Math.max(0.54, primary.score - 0.34);
    const closest = [];
    for (const template of templates) {
      if (options.entityType && options.entityType !== template.entry.type) continue;
      const aspect = template.width * reference.height / (template.height * reference.width);
      if (aspect < 0.76 || aspect > 1.31 || (template.darkSilhouette && !reference.darkSilhouette)) continue;
      if (names.has(answerName(template.entry)) && (template.aliases ?? []).every(alias => names.has(answerName(alias)))) continue;
      for (const mirrored of [false, true]) {
        const shape = silhouetteScore(reference.silhouette, template.silhouette, referenceMirrored !== mirrored);
        if (shape < 0.61) continue;
        const appearance = subjectAppearance(screen, template, box, clip, mirrored, shape);
        if (appearance < minimum) continue;
        const score = Math.min(primary.score, appearance * 0.91);
        const candidate = matchFromTemplate(template, box, score, 'normalized', mirrored);
        closest.push(candidate, ...(candidate.alternatives ?? []));
      }
    }
    closest.sort(compareMatches);
    for (const candidate of closest) {
      const name = answerName(candidate);
      if (names.has(name)) continue;
      names.add(name);
      const { alternatives, ...result } = candidate;
      matches.push(result);
      if (matches.length === limit) break;
    }
    return [primary, ...matches.slice(1).sort(compareMatches)];
  }

  function foregroundBox(screen) {
    const { pixels, width, height } = screen;
    const perimeter = [];
    for (let index = 0; index < 16; index += 1) {
      const x = Math.round(index * (width - 1) / 15);
      const y = Math.round(index * (height - 1) / 15);
      perimeter.push(pixels[x], pixels[(height - 1) * width + x], pixels[y * width], pixels[(y + 1) * width - 1]);
    }
    const transparent = perimeter.filter(pixel => !isVisible(pixel)).length > 4;
    let foreground = isVisible;
    if (!transparent) {
      // A nearly uniform perimeter also gives a usable mask on solid screenshot padding.
      let background;
      let bestCount = 0;
      for (const color of perimeter) {
        const count = perimeter.filter(sample => rgbError(color, sample) <= 24).length;
        if (count > bestCount) {
          bestCount = count;
          background = color;
        }
      }
      if (bestCount < perimeter.length * 0.87) return null;
      foreground = pixel => isVisible(pixel) && rgbError(pixel, background) > 42;
    }

    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!foreground(pixels[y * width + x])) continue;
        count += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    const box = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
    if (count < 24 || box.width < 6 || box.height < 6) return { empty: true };
    return { box, foreground, transparent, signature: shapeSignature(pixels, width, box, foreground) };
  }

  function silhouetteScore(a, b, mirrored) {
    let difference = 0;
    let union = 0;
    for (let index = 0; index < a.length; index += 1) {
      const column = index % SIGNATURE_SIDE;
      const corresponding = mirrored ? index - 2 * column + SIGNATURE_SIDE - 1 : index;
      difference += Math.abs(a[index] - b[corresponding]);
      union += Math.max(a[index], b[corresponding]);
    }
    return union > 0 ? 1 - difference / union : 0;
  }

  function normalizedPixelError(screen, point, foreground, position) {
    const pixel = screen.pixels[position];
    if (foreground && !foreground(pixel)) return 174;
    return 2 * Math.abs(screen.lightValues[position] - point.light) + rgbError(pixel, point.pixel) / 3;
  }

  function normalizedColorError(screen, point, geometry) {
    const { box, templateWidth, mirrored, foreground, scaleX, scaleY, radius, right, bottom } = geometry;
    const localX = mirrored ? templateWidth - point.x - 0.5 : point.x + 0.5;
    const x = box.x + Math.floor(localX * scaleX);
    const y = box.y + Math.floor((point.y + 0.5) * scaleY);
    let error = normalizedPixelError(screen, point, foreground, y * screen.width + x);
    if (error > 34) {
      // A resize or JPEG can shift thin outlines by a pixel.
      for (let side = 0; side < 4; side += 1) {
        const sampleX = x + radius * EDGE_STEP_X[side];
        const sampleY = y + radius * EDGE_STEP_Y[side];
        if (sampleX < box.x || sampleY < box.y || sampleX >= right || sampleY >= bottom) continue;
        error = Math.min(error, 9 + normalizedPixelError(screen, point, foreground, sampleY * screen.width + sampleX));
      }
    }
    return error;
  }

  function normalizedColorScore(screen, view, shapeScore) {
    const { box, template, mirrored, foreground } = view;
    const scaleX = box.width / template.width;
    const scaleY = box.height / template.height;
    const geometry = {
      box, templateWidth: template.width, mirrored, foreground, scaleX, scaleY,
      radius: Math.min(3, Math.max(1, Math.floor(scaleX / 3))),
      right: box.x + box.width, bottom: box.y + box.height,
    };
    const { quickAnchors, samples } = template;
    screen.lightValues ??= Uint8Array.from(screen.pixels, luminance);
    const anchorMissLimit = quickAnchors.length - Math.ceil(quickAnchors.length * 0.7);
    let anchorMisses = 0;
    for (const point of quickAnchors) {
      if (normalizedColorError(screen, point, geometry) > 63 && ++anchorMisses > anchorMissLimit) return 0;
    }

    let errorSum = 0;
    let inliers = 0;
    let misses = 0;
    for (const point of samples) {
      const error = normalizedColorError(screen, point, geometry);
      errorSum += Math.min(error, 175);
      if (error <= 63) inliers += 1;
      else if (++misses > samples.length * 0.21) return 0;
    }
    const colors = 0.61 * inliers / samples.length + 0.39 * (1 - errorSum / (175 * samples.length));
    if (shapeScore !== undefined) return 0.76 * colors + 0.24 * shapeScore;
    if (colors < 0.88) return 0;

    // On a game backdrop, require visible evidence at the expected sprite outline.
    let edges = 0;
    let visible = 0;
    for (const point of template.contour) {
      const insideX = box.x + Math.floor((mirrored ? template.width - point.x - 0.5 : point.x + 0.5) * scaleX);
      const outsideX = box.x + Math.floor((mirrored ? template.width - point.outsideX - 0.5 : point.outsideX + 0.5) * scaleX);
      const insideY = box.y + Math.floor((point.y + 0.5) * scaleY);
      const outsideY = box.y + Math.floor((point.outsideY + 0.5) * scaleY);
      if (outsideX < 0 || outsideY < 0 || outsideX >= screen.width || outsideY >= screen.height
        || (insideX === outsideX && insideY === outsideY)) continue;
      edges += 1;
      if (rgbError(screen.pixels[insideY * screen.width + insideX], screen.pixels[outsideY * screen.width + outsideX]) >= 28) visible += 1;
    }
    if ((edges < 6 && needsContour(template)) || (edges >= 6 && visible < edges * 0.42)) return 0;
    return colors * (edges >= 6 ? 0.92 + 0.08 * visible / edges : 0.96);
  }

  function cropPlacements(screen, template) {
    const fit = Math.min(screen.width / template.width, screen.height / template.height);
    const boxes = [];
    for (const fill of [1, 0.96, 0.91, 0.86, 0.80, 0.73, 0.65]) {
      const width = Math.round(template.width * fit * fill);
      const height = Math.round(template.height * fit * fill);
      if (width < 8 || height < 8 || width * height < 0.28 * screen.width * screen.height) continue;
      const spareX = screen.width - width;
      const spareY = screen.height - height;
      const positions = spareX <= 3 && spareY <= 3 ? [[0.5, 0.5]]
        : [[0.5, 0.5], [0.24, 0.24], [0.76, 0.24], [0.24, 0.76], [0.76, 0.76]];
      for (const [biasX, biasY] of positions) {
        boxes.push({ x: Math.round(spareX * biasX), y: Math.round(spareY * biasY), width, height });
      }
    }
    return boxes;
  }

  function cardPlacementScore(screen, template, box, card, mirrored, probes, coarse, allowContrastShift = false) {
    const scaleX = box.width / template.width;
    const scaleY = box.height / template.height;
    const clipRight = card.x + card.width;
    const clipBottom = card.y + card.height;
    const coordinateX = point => box.x + Math.floor((mirrored ? template.width - point.x - 0.5 : point.x + 0.5) * scaleX);
    const coordinateY = point => box.y + Math.floor((point.y + 0.5) * scaleY);
    const radius = coarse ? Math.max(1, Math.round(Math.min(card.width, card.height) * 0.022)) : Math.max(1, Math.round(scaleX));
    let seen = 0;
    let good = 0;
    let errorSum = 0;
    for (const point of probes) {
      const x = coordinateX(point);
      const y = coordinateY(point);
      if (x < card.x || y < card.y || x >= clipRight || y >= clipBottom) continue;
      let error = screenedError(screen, y * screen.width + x, point);
      if (error > 34) {
        for (let side = 0; side < 4; side += 1) {
          const fx = x + radius * EDGE_STEP_X[side];
          const fy = y + radius * EDGE_STEP_Y[side];
          if (fx < card.x || fy < card.y || fx >= clipRight || fy >= clipBottom) continue;
          error = Math.min(error, 9 + screenedError(screen, fy * screen.width + fx, point));
        }
      }
      seen += 1;
      good += Number(error <= 78);
      errorSum += Math.min(error, 180);
      if (seen - good > probes.length * (coarse ? 0.49 : 0.26)) return 0;
    }
    if (seen < probes.length * (coarse ? 0.75 : 0.86) || good < seen * (coarse ? 0.58 : 0.74)) return 0;
    const colorScore = (0.51 * good / seen + 0.49 * (1 - errorSum / (280 * seen)));
    if (coarse) return colorScore;

    let correct = 0;
    let checked = 0;
    for (const { a, b, difference } of template.contrast) {
      const x1 = coordinateX(a);
      const x2 = coordinateX(b);
      const y1 = coordinateY(a);
      const y2 = coordinateY(b);
      if (Math.min(x1, x2) < card.x || Math.min(y1, y2) < card.y
        || Math.max(x1, x2) >= clipRight || Math.max(y1, y2) >= clipBottom || (x1 === x2 && y1 === y2)) continue;
      const actual = screen.lightValues[y1 * screen.width + x1] - screen.lightValues[y2 * screen.width + x2];
      checked += 1;
      const direction = Math.sign(difference);
      const minimum = Math.abs(difference) * 0.24;
      if (direction * actual >= minimum) {
        correct += 1;
      } else if (allowContrastShift) {
        // Move both points by the same small amount to tolerate a subpixel sampling shift.
        for (let side = 0; side < 4; side += 1) {
          const dx = radius * EDGE_STEP_X[side];
          const dy = radius * EDGE_STEP_Y[side];
          if (Math.min(x1, x2) + dx < card.x || Math.min(y1, y2) + dy < card.y
            || Math.max(x1, x2) + dx >= clipRight || Math.max(y1, y2) + dy >= clipBottom) continue;
          const shift = dy * screen.width + dx;
          const shifted = screen.lightValues[y1 * screen.width + x1 + shift] - screen.lightValues[y2 * screen.width + x2 + shift];
          if (direction * shifted < minimum) continue;
          correct += 1;
          break;
        }
      }
    }
    if (checked < 8 || correct < checked * 0.52) return 0;
    return 0.88 * colorScore + 0.12 * correct / checked;
  }

  function rankCardTemplates(screen, card, options, silhouette, pool = templates) {
    const histogram = new Uint32Array(JPEG_BUCKET_COUNT);
    for (let y = card.y; y < card.y + card.height; y += 1) {
      for (let x = card.x; x < card.x + card.width; x += 1) {
        const index = y * screen.width + x;
        histogram[jpegKey(screen.pixels[index], screen.lightValues[index])] += 1;
      }
    }
    const ranks = [];
    for (const template of pool) {
      if (template.darkSilhouette || template.contrast.length < 8
        || (options.entityType && options.entityType !== template.entry.type)) continue;
      let shape = 0;
      if (silhouette) {
        const aspect = card.width * template.height / (card.height * template.width);
        if (aspect < 0.72 || aspect > 1.38) continue;
        shape = Math.max(silhouetteScore(silhouette, template.silhouette, false), silhouetteScore(silhouette, template.silhouette, true));
        if (shape < 0.62) continue;
      }
      const palette = takeSpread(template.samples, 26);
      let support = 0;
      for (const point of palette) {
        const key = jpegKey(point.pixel, point.light);
        if (histogram[key] >= 2) support += 1;
        else if (neighboringKeys(point.pixel).some(neighbor => histogram[neighbor] > 0)) support += 0.6;
      }
      support /= palette.length;
      if (support >= 0.51) ranks.push({ template, score: support + 1.25 * shape });
    }
    return ranks.sort((a, b) => b.score - a.score);
  }

  function rankCardForeground(screen, card, ranked) {
    const insetX = Math.max(1, Math.round(card.width * 0.15));
    const insetY = Math.max(1, Math.round(card.height * 0.09));
    const centerWidth = card.width - 2 * insetX;
    const centerHeight = card.height - 2 * insetY;
    const centerArea = centerWidth * centerHeight;
    const edgeArea = card.width * card.height - centerArea;
    const center = new Uint32Array(JPEG_BUCKET_COUNT);
    const edges = new Uint32Array(JPEG_BUCKET_COUNT);
    for (let y = 0; y < card.height; y += 1) {
      for (let x = 0; x < card.width; x += 1) {
        const index = (card.y + y) * screen.width + card.x + x;
        const key = jpegKey(screen.pixels[index], screen.lightValues[index]);
        const inside = x >= insetX && y >= insetY && x < card.width - insetX && y < card.height - insetY;
        (inside ? center : edges)[key] += 1;
      }
    }

    // Favor colors concentrated around the character over colors repeated around the card border.
    const evidence = Float32Array.from(center, (count, key) => Math.max(0, count - edges[key] * centerArea / edgeArea));
    const strengths = Float32Array.from(evidence, count => Math.min(1, Math.log2(1 + count) / 6));
    return ranked.map(({ template }) => {
      const palette = takeSpread(template.samples, 26);
      let support = 0;
      for (const point of palette) {
        const key = jpegKey(point.pixel, point.light);
        if (center[key] || edges[key]) support += strengths[key];
        else {
          let count = 0;
          for (const neighbor of neighboringKeys(point.pixel)) count += evidence[neighbor];
          support += 0.4 * Math.min(1, Math.log2(1 + count) / 6);
        }
      }
      return { template, score: support / palette.length };
    }).sort((a, b) => b.score - a.score);
  }

  function cardBackdrop(screen, card) {
    const colors = [];
    const step = Math.max(1, Math.round(Math.min(card.width, card.height) / 42));
    for (let y = card.y; y < card.y + card.height; y += step) {
      for (let x = card.x; x < card.x + card.width; x += step) {
        const position = y * screen.width + x;
        colors.push({ pixel: screen.pixels[position], light: screen.lightValues[position] });
      }
    }
    colors.sort((a, b) => b.light - a.light);
    const bright = colors.slice(0, Math.ceil(colors.length / 4));
    const averages = [0, 0, 0];
    for (const { pixel } of bright) {
      for (let channel = 0; channel < 3; channel += 1) averages[channel] += (pixel >>> (channel * 8)) & 255;
    }
    return averages.map(sum => sum / bright.length);
  }

  function cardHasDetails(screen, card) {
    const distance = Math.max(1, Math.round(Math.min(card.width, card.height) / 140));
    const interiorPixels = (card.width - 2 * distance) * (card.height - 2 * distance);
    const required = Math.max(12, Math.ceil(interiorPixels * 0.01));
    const vertical = distance * screen.width;
    const lights = screen.lightValues;
    let details = 0;
    for (let y = card.y + distance; y < card.y + card.height - distance; y += 1) {
      for (let x = card.x + distance; x < card.x + card.width - distance; x += 1) {
        const position = y * screen.width + x;
        const center = 2 * lights[position];
        const horizontalEdge = Math.abs(lights[position - distance] - center + lights[position + distance]);
        const verticalEdge = Math.abs(lights[position - vertical] - center + lights[position + vertical]);
        if (Math.max(horizontalEdge, verticalEdge) >= 20 && ++details >= required) return true;
      }
    }
    return false;
  }

  function cardFocusBounds(screen, card, distance = Math.max(1, Math.round(Math.min(card.width, card.height) / 140))) {
    const columns = new Uint32Array(card.width);
    const rows = new Uint32Array(card.height);
    const vertical = distance * screen.width;
    const lights = screen.lightValues;
    let count = 0;
    for (let y = distance; y < card.height - distance; y += 1) {
      for (let x = distance; x < card.width - distance; x += 1) {
        const position = (card.y + y) * screen.width + card.x + x;
        const center = 2 * lights[position];
        const horizontal = Math.abs(lights[position - distance] - center + lights[position + distance]);
        const verticalEdge = Math.abs(lights[position - vertical] - center + lights[position + vertical]);
        if (Math.max(horizontal, verticalEdge) <= 27) continue;
        columns[x] += 1;
        rows[y] += 1;
        count += 1;
      }
    }
    if (count < 24) return null;
    const quantile = (values, fraction) => {
      const limit = Math.max(1, count * fraction);
      let sum = 0;
      for (let index = 0; index < values.length; index += 1) {
        sum += values[index];
        if (sum >= limit) return index;
      }
      return values.length - 1;
    };
    const left = quantile(columns, 0.004);
    const top = quantile(rows, 0.004);
    const width = quantile(columns, 0.996) - left + 1;
    const height = quantile(rows, 0.996) - top + 1;
    if (Math.min(width, height) < 9) return null;
    return { x: card.x + left, y: card.y + top, width, height };
  }

  function cardSubjectFocus(screen, card) {
    const shorterSide = Math.min(card.width, card.height);
    const distance = Math.max(1, Math.round(shorterSide / 140));
    const tileSize = Math.max(3, Math.round(shorterSide / 72));
    const columns = Math.ceil(card.width / tileSize);
    const rows = Math.ceil(card.height / tileSize);
    const tiles = new Uint32Array(columns * rows);
    const vertical = distance * screen.width;
    const lights = screen.lightValues;
    let total = 0;
    for (let y = distance; y < card.height - distance; y += 1) {
      const row = Math.floor(y / tileSize) * columns;
      for (let x = distance; x < card.width - distance; x += 1) {
        const pixel = (card.y + y) * screen.width + card.x + x;
        const twiceLight = 2 * lights[pixel];
        const horizontal = Math.abs(lights[pixel - distance] - twiceLight + lights[pixel + distance]);
        const verticalEdge = Math.abs(lights[pixel - vertical] - twiceLight + lights[pixel + vertical]);
        if (Math.max(horizontal, verticalEdge) <= 27) continue;
        tiles[row + Math.floor(x / tileSize)] += 1;
        total += 1;
      }
    }

    // Join nearby stroke tiles without letting isolated pointers or specks set the subject bounds.
    const primary = largestCardComponent(tiles, columns, rows, 3);
    if (!primary || primary.count < Math.max(24, total * 0.65)) return null;

    const left = Math.max(0, (primary.left - 1) * tileSize);
    const top = Math.max(0, (primary.top - 1) * tileSize);
    const width = Math.min(card.width, (primary.right + 2) * tileSize) - left;
    const height = Math.min(card.height, (primary.bottom + 2) * tileSize) - top;
    const connected = { x: card.x + left, y: card.y + top, width, height };
    const focus = cardFocusBounds(screen, connected, distance);
    if (!focus) return null;
    const coverage = focus.width * focus.height / (card.width * card.height);
    if (coverage < 0.08) return null;
    const centerX = (focus.x + focus.width / 2 - card.x) / card.width;
    const centerY = (focus.y + focus.height / 2 - card.y) / card.height;
    const offCenter = centerX < 0.33 || centerX > 0.67 || centerY < 0.32 || centerY > 0.68;
    if (offCenter) return { ...focus, offCenter };
    if (shorterSide < 160 || coverage > 0.50) return null;
    return { ...focus, ink: cardInkBounds(screen, card, connected, focus) };
  }

  function largestCardComponent(tiles, columns, rows, radius) {
    const seen = new Uint8Array(tiles.length);
    const pending = new Uint32Array(tiles.length);
    let primary;
    for (let start = 0; start < tiles.length; start += 1) {
      if (seen[start] || tiles[start] < 2) continue;
      seen[start] = 1;
      pending[0] = start;
      let length = 1;
      let count = 0;
      let left = columns;
      let top = rows;
      let right = 0;
      let bottom = 0;
      for (let index = 0; index < length; index += 1) {
        const tile = pending[index];
        const x = tile % columns;
        const y = Math.floor(tile / columns);
        count += tiles[tile];
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (let row = Math.max(0, y - radius); row <= Math.min(rows - 1, y + radius); row += 1) {
          for (let column = Math.max(0, x - radius); column <= Math.min(columns - 1, x + radius); column += 1) {
            const next = row * columns + column;
            if (seen[next] || tiles[next] < 2) continue;
            seen[next] = 1;
            pending[length++] = next;
          }
        }
      }
      if (!primary || count > primary.count) primary = { count, left, top, right, bottom };
    }
    return primary;
  }

  function cardInkBounds(screen, card, region, focus, allowEdges = false) {
    let left = region.x + region.width;
    let top = region.y + region.height;
    let right = region.x - 1;
    let bottom = region.y - 1;
    let darkPixels = 0;
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        if (screen.lightValues[y * screen.width + x] > 80) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        darkPixels += 1;
      }
    }
    const pixels = card.width * card.height;
    if (darkPixels < pixels * 0.01 || darkPixels > pixels * (allowEdges ? 0.58 : 0.33)) return null;
    const width = right - left + 1;
    const height = bottom - top + 1;
    const area = width * height;
    if (area < pixels * 0.06 || area >= (allowEdges ? 0.97 : 0.90) * focus.width * focus.height) return null;
    if (!allowEdges && (left < card.x + 2 || top < card.y + 2 || right >= card.x + card.width - 2
      || bottom >= card.y + card.height - 2)) return null;
    return { x: left, y: top, width, height };
  }

  function dominantDarkCardFocus(screen, card, allowEdges = false) {
    const tileSize = Math.max(3, Math.round(Math.min(card.width, card.height) / 72));
    const columns = Math.ceil(card.width / tileSize);
    const rows = Math.ceil(card.height / tileSize);
    const tiles = new Uint32Array(columns * rows);
    let darkPixels = 0;
    for (let y = 0; y < card.height; y += 1) {
      const row = Math.floor(y / tileSize) * columns;
      for (let x = 0; x < card.width; x += 1) {
        if (screen.lightValues[(card.y + y) * screen.width + card.x + x] > 80) continue;
        tiles[row + Math.floor(x / tileSize)] += 1;
        darkPixels += 1;
      }
    }
    const area = card.width * card.height;
    if (darkPixels < 0.01 * area || darkPixels > (allowEdges ? 0.58 : 0.30) * area) return null;
    const primary = largestCardComponent(tiles, columns, rows, 1);
    if (!primary || primary.count < 0.65 * darkPixels) return null;

    const left = primary.left * tileSize;
    const top = primary.top * tileSize;
    const width = Math.min(card.width, (primary.right + 1) * tileSize) - left;
    const height = Math.min(card.height, (primary.bottom + 1) * tileSize) - top;
    const connected = { x: card.x + left, y: card.y + top, width, height };
    const focus = cardInkBounds(screen, card, connected, card, allowEdges);
    return focus && focus.width * focus.height <= (allowEdges ? 0.95 : 0.5) * area ? focus : null;
  }

  function hasOpaqueCardCorners(screen, region) {
    const { pixels, width: stride } = screen;
    const { x, y, width, height } = region;
    if (Math.min(width, height) < 24) return false;
    const first = y * stride + x;
    const lastRow = first + (height - 1) * stride;
    const corners = [first, first + width - 1, lastRow, lastRow + width - 1];
    return corners.every(index => (pixels[index] >>> 24) >= 224);
  }

  function hasOpaqueCardInterior(screen, region) {
    if (hasOpaqueCardCorners(screen, region)) return true;
    const { x, y, width, height } = region;
    return hasOpaqueCardCorners(screen, { x: x + 1, y: y + 1, width: width - 2, height: height - 2 });
  }

  function opaqueAlphaPanel(screen, box) {
    let left = box.x + box.width;
    let top = box.y + box.height;
    let right = box.x - 1;
    let bottom = box.y - 1;
    let count = 0;
    const { pixels, width: stride } = screen;
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        if ((pixels[y * stride + x] >>> 24) < 224) continue;
        count += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    const width = right - left + 1;
    const height = bottom - top + 1;
    if (Math.min(width, height) < 32 || count < 0.97 * width * height) return null;
    const panel = { x: left, y: top, width, height };
    return hasOpaqueCardInterior(screen, panel) ? panel : null;
  }

  function hasCoolCardBorder(screen, region) {
    if (Math.min(region.width, region.height) < 40 || !hasOpaqueCardInterior(screen, region)) return false;
    const { pixels, width: stride } = screen;
    let cool = 0;
    let background = 0;
    const samples = 24;
    const count = 4 * samples;
    const examine = (x, y) => {
      const pixel = pixels[y * stride + x];
      if ((pixel >>> 24) < 224) return;
      const red = pixel & 255;
      const green = (pixel >>> 8) & 255;
      const blue = (pixel >>> 16) & 255;
      if (blue >= red + 14 && blue >= green + 4 && 3 * red + 5 * green + 2 * blue >= 900) {
        cool += 1;
        background += 1;
      } else if (Math.min(red, green, blue) >= 195) {
        background += 1;
      }
    };
    for (let index = 0; index < samples; index += 1) {
      const fraction = 0.08 + 0.84 * ((index + 0.5) / samples);
      const x = region.x + Math.floor(fraction * region.width);
      const y = region.y + Math.floor(fraction * region.height);
      examine(x, region.y + 2);
      examine(x, region.y + region.height - 3);
      examine(region.x + 2, y);
      examine(region.x + region.width - 3, y);
    }
    return cool >= 0.58 * count && background >= 0.88 * count;
  }

  function opaqueCardBounds(screen, region, tight = false) {
    if (!(tight ? hasOpaqueCardInterior(screen, region) : hasOpaqueCardCorners(screen, region))) return null;
    const { pixels, width: stride } = screen;
    const { x, y, width, height } = region;

    screen.lightValues ??= Uint8Array.from(pixels, luminance);
    const distance = Math.max(1, Math.round(Math.min(width, height) / 140));
    const edgeFraction = tight ? 0.045 : 0.08;
    const sideX = Math.max(3, Math.round(width * edgeFraction));
    const sideY = Math.max(3, Math.round(height * edgeFraction));
    const vertical = distance * stride;
    const lights = screen.lightValues;
    const quiet = (left, top, right, bottom) => {
      let edges = 0;
      let count = 0;
      for (let row = top; row < bottom; row += distance) {
        for (let column = left; column < right; column += distance) {
          const position = (y + row) * stride + x + column;
          const twiceLight = 2 * lights[position];
          const horizontal = Math.abs(lights[position - distance] - twiceLight + lights[position + distance]);
          const verticalEdge = Math.abs(lights[position - vertical] - twiceLight + lights[position + vertical]);
          edges += Number(Math.max(horizontal, verticalEdge) >= 20);
          count += 1;
        }
      }
      return count > 0 && edges / count <= 0.025;
    };
    let quietSides = 0;
    if (quiet(distance, distance, width - distance, distance + sideY)) quietSides += 1;
    if (quiet(distance, height - distance - sideY, width - distance, height - distance)) quietSides += 1;
    if (quiet(distance, distance, distance + sideX, height - distance)) quietSides += 1;
    if (quiet(width - distance - sideX, distance, width - distance, height - distance)) quietSides += 1;
    return quietSides >= 2 ? region : null;
  }

  function inferredMatteCard(screen, subject, coverage) {
    if (!subject || subject.transparent || coverage < 0.88) return null;
    const { box, signature } = subject;
    if (box.width * box.height > 0.94 * screen.width * screen.height) return null;
    const side = SIGNATURE_SIDE;
    const far = side - 2;
    const corners = [0, far, far * side, far * (side + 1)];
    let filledCorners = 0;
    for (const corner of corners) {
      const filled = signature[corner] + signature[corner + 1] + signature[corner + side] + signature[corner + side + 1];
      if (filled >= 12) filledCorners += 1;
    }
    return filledCorners >= 3 ? box : null;
  }

  function coversCardFocus(pose, focus, focusCoverage = 0.55, poseCoverage = 0.45) {
    const width = Math.min(pose.x + pose.width, focus.x + focus.width) - Math.max(pose.x, focus.x);
    const height = Math.min(pose.y + pose.height, focus.y + focus.height) - Math.max(pose.y, focus.y);
    if (width <= 0 || height <= 0) return false;
    const overlap = width * height;
    return overlap >= focusCoverage * focus.width * focus.height && overlap >= poseCoverage * pose.width * pose.height;
  }

  function compositeTemplate(template, backdrop) {
    const samples = template.samples.map(point => {
      const alpha = (point.pixel >>> 24) / 255;
      let pixel = 0xff000000;
      for (let channel = 0; channel < 3; channel += 1) {
        const shift = channel * 8;
        const source = (point.pixel >>> shift) & 255;
        pixel |= Math.round(source * alpha + backdrop[channel] * (1 - alpha)) << shift;
      }
      return { ...point, pixel: pixel >>> 0, light: luminance(pixel) };
    });
    const lights = new Map(samples.map(point => [point.y * template.width + point.x, point.light]));
    const contrast = template.contrast.map(({ a, b, difference }) => {
      const first = lights.get(a.y * template.width + a.x);
      const second = lights.get(b.y * template.width + b.x);
      return { a, b, difference: first === undefined || second === undefined ? difference : first - second };
    }).filter(pair => Math.abs(pair.difference) >= 28);
    return { ...template, samples, contrast };
  }

  function recognizeTranslucentCard(screen, card, options, candidateLimit, focus) {
    if (!translucentTemplates.length) return [];
    const backdrop = cardBackdrop(screen, card);
    const composites = translucentTemplates.map(template => compositeTemplate(template, backdrop));
    const ranked = rankCardTemplates(screen, card, options, null, composites).slice(0, 100);
    const centered = refineCardWinner(screen, card, searchCardPlacements(screen, card, ranked, candidateLimit, 'center'));
    if (!focus || (centered[0]?.score ?? 0) >= 0.91) return centered;
    const local = rankCardTemplates(screen, focus, options, null, composites);
    const localized = searchFocusedCard(screen, card, local, rankCardForeground(screen, focus, local), candidateLimit, focus, false, true);
    return (localized[0]?.score ?? 0) > (centered[0]?.score ?? 0) ? localized : centered;
  }

  function searchCardPlacements(screen, card, ranked, candidateLimit, mode = 'wide') {
    const useProbeBounds = mode === 'probes';
    const fills = useProbeBounds ? [0.60, 0.66, 0.72, 0.76, 0.82, 0.90, 0.95, 1, 1.07]
      : mode === 'center' ? [0.76, 0.80, 0.84, 0.88, 0.91, 0.94, 0.98, 1.01] : [0.72, 0.82, 0.9, 0.95, 1, 1.07];
    const centerColumns = mode === 'center' ? [0.46, 0.50, 0.54, 0.58] : [0.36, 0.43, 0.5, 0.585, 0.65];
    const centerRows = mode === 'center' ? [0.44, 0.48, 0.505, 0.52, 0.56] : [0.39, 0.445, 0.48, 0.535, 0.59];
    const shortlist = [];
    for (const { template } of ranked) {
      const bounds = useProbeBounds ? template.probeBounds : { x: 0, y: 0, width: template.width, height: template.height };
      if (!bounds) continue;
      const fit = Math.min(card.width / bounds.width, card.height / bounds.height);
      const probes = takeSpread(template.samples, 19);
      for (const mirrored of [false, true]) {
        const poses = [];
        const bodyX = mirrored ? template.width - bounds.x - bounds.width / 2 : bounds.x + bounds.width / 2;
        const bodyY = bounds.y + bounds.height / 2;
        for (const fill of fills) {
          const scale = fit * fill;
          const width = Math.round(template.width * scale);
          const height = Math.round(template.height * scale);
          const coverage = bounds.width * bounds.height * scale * scale / (card.width * card.height);
          if (useProbeBounds ? coverage < 0.30 : width * height < card.width * card.height * 0.36) continue;
          for (const centerX of centerColumns) {
            const x = card.x + Math.round(card.width * centerX - (useProbeBounds ? bodyX * scale : width / 2));
            for (const centerY of centerRows) {
              const y = card.y + Math.round(card.height * centerY - (useProbeBounds ? bodyY * scale : height / 2));
              const box = { x, y, width, height };
              const score = cardPlacementScore(screen, template, box, card, mirrored, probes, true);
              if (score >= 0.73) poses.push({ template, box, mirrored, score });
            }
          }
        }
        poses.sort((a, b) => b.score - a.score);
        shortlist.push(...poses.slice(0, 4));
      }
    }
    return refineCardPlacements(screen, card, shortlist, candidateLimit, mode);
  }

  function clippedCardSides(card, focus) {
    const tolerance = Math.max(2, Math.round(Math.min(card.width, card.height) * 0.022));
    const nearby = [
      ['left', focus.x - card.x], ['top', focus.y - card.y],
      ['right', card.x + card.width - focus.x - focus.width],
      ['bottom', card.y + card.height - focus.y - focus.height],
    ].filter(([, gap]) => gap <= tolerance);
    return nearby.map(([side]) => side);
  }

  function extendsPastCardSide(box, card, side) {
    switch (side) {
      case 'left': return box.x < card.x;
      case 'right': return box.x + box.width > card.x + card.width;
      case 'top': return box.y < card.y;
      case 'bottom': return box.y + box.height > card.y + card.height;
      default: return false;
    }
  }

  function focusedScales(bounds, focus, sizes, clippedSides, gentleClipping = false) {
    const widthScale = focus.width / bounds.width;
    const heightScale = focus.height / bounds.height;
    const scales = [];
    const multiEdge = clippedSides.length > 1;
    const minimumExtension = multiEdge && !gentleClipping ? 1.12 : 1.05;
    for (const [adjustX, adjustY] of sizes) {
      const scaleX = widthScale * adjustX;
      const scaleY = heightScale * adjustY;
      const aspect = scaleX / scaleY;
      if (aspect >= 0.78 && aspect <= 1.28) scales.push({ scaleX, scaleY });
      // Infer the clipped axis from the more visible axis. Multiple nearby edges
      // also permit a small part of the overhang on the opposite side.
      for (const clippedSide of clippedSides) {
        const horizontal = clippedSide === 'left' || clippedSide === 'right';
        const extendedX = horizontal ? scaleY * adjustX : scaleX;
        const extendedY = horizontal ? scaleY : scaleX * adjustY;
        const extension = horizontal ? extendedX / widthScale : extendedY / heightScale;
        if (extension < minimumExtension || extension > 1.52) continue;
        scales.push({ scaleX: extendedX, scaleY: extendedY, clippedSide });
        if (multiEdge) {
          scales.push({ scaleX: extendedX, scaleY: extendedY, clippedSide, anchor: 0.5 });
          const bothSides = clippedSide === 'left' && clippedSides.includes('right')
            || clippedSide === 'top' && clippedSides.includes('bottom');
          if (bothSides) scales.push({ scaleX: extendedX, scaleY: extendedY, clippedSide, anchor: 0 });
        }
      }
    }
    return scales;
  }

  function searchFocusedCard(screen, card, ranked, foregroundRanks, candidateLimit, preferredFocus, clippedOnly = false, fineRecovery = false, edgeHints) {
    const focus = preferredFocus ?? cardFocusBounds(screen, card);
    if (!focus) return [];
    const sizes = [[1, 1], [1.045, 1], [1, 1.045], [1.045, 1.045], [0.955, 1], [1, 0.955], [1.045, 0.955], [0.955, 1.045]];
    if (preferredFocus) sizes.push([0.975, 1.03], [1.03, 0.975]);
    const tighterOffCenter = fineRecovery && !clippedOnly && preferredFocus?.offCenter;
    const tightlyBounded = fineRecovery && !clippedOnly && !tighterOffCenter;
    if (tightlyBounded) sizes.push([1.02, 1.035], [1.02, 0.975], [0.985, 1.025], [0.975, 0.985]);
    if (tighterOffCenter) sizes.push([0.97, 1.03], [0.97, 1.06], [1.03, 0.97], [1.06, 0.97]);
    if (clippedOnly && fineRecovery) sizes.push([1.06, 0.975], [0.975, 1.06], [1.035, 1.02], [1.02, 1.035]);
    const nearbySides = edgeHints ?? clippedCardSides(card, focus);
    const clippedSides = clippedOnly || nearbySides.length === 1 ? nearbySides : [];
    if (clippedOnly && clippedSides.length > 1) sizes.push([1.06, 1], [1, 1.06]);
    const profilesByTemplate = new Map();
    for (const { template } of ranked) {
      const fullBounds = { x: 0, y: 0, width: template.width, height: template.height };
      const profiles = template.probeBounds ? [fullBounds, template.probeBounds] : [fullBounds];
      const compatible = profiles.map(bounds => ({
        bounds,
        scales: focusedScales(bounds, focus, sizes, clippedSides, clippedOnly && fineRecovery).filter(scale => !clippedOnly || scale.clippedSide),
      }))
        .filter(profile => profile.scales.length);
      if (compatible.length) profilesByTemplate.set(template, compatible);
    }
    const beforeBudget = ({ template }) => profilesByTemplate.has(template);
    const limited = tighterOffCenter || tightlyBounded;
    // A heavily cropped sprite can lose distinctive colors at several edges.
    const widerClip = clippedOnly && fineRecovery && clippedSides.length >= 3;
    const focusedLimit = limited ? 120 : widerClip ? 520 : clippedOnly ? 240 : 480;
    const paletteLimit = limited ? 180 : widerClip ? 1250 : clippedOnly ? 480 : 1400;
    const focusedPool = foregroundRanks.filter(beforeBudget).slice(0, focusedLimit);
    const widerPool = ranked.filter(beforeBudget).slice(0, paletteLimit);
    const pool = new Set([...focusedPool, ...widerPool].map(({ template }) => template));

    // A nearly full card can contain decorations outside the main subject's edge box.
    const shifts = [[0, 0]];
    if (focus.width >= card.width * 0.82) {
      const shift = Math.round(focus.width * 0.04);
      shifts.push([-shift, 0], [shift, 0]);
    }
    if (focus.height >= card.height * 0.82) {
      const shift = Math.round(focus.height * 0.04);
      shifts.push([0, -shift], [0, shift]);
    }
    if (limited) {
      const shortX = Math.max(1, Math.round(focus.width * 0.02));
      const shortY = Math.max(1, Math.round(focus.height * 0.02));
      for (const x of [-shortX, 0, shortX]) {
        for (const y of [-shortY, 0, shortY]) {
          if (x || y) shifts.push([x, y]);
        }
      }
    }
    const shortlist = [];
    const verified = [];
    for (const template of pool) {
      // A thin outline can appear in the card's edge bounds even when interior probes omit it.
      const probes = takeSpread(template.samples, 19);
      for (const { bounds, scales } of profilesByTemplate.get(template)) {
        for (const mirrored of [false, true]) {
          const bodyX = mirrored ? template.width - bounds.x - bounds.width / 2 : bounds.x + bounds.width / 2;
          const bodyY = bounds.y + bounds.height / 2;
          for (const { scaleX, scaleY, clippedSide: side, anchor = 1 } of scales) {
            const xExtension = (bounds.width * scaleX - focus.width) / 2;
            const yExtension = (bounds.height * scaleY - focus.height) / 2;
            const slideX = side === 'right' ? xExtension * anchor : side === 'left' ? -xExtension * anchor : 0;
            const slideY = side === 'bottom' ? yExtension * anchor : side === 'top' ? -yExtension * anchor : 0;
            const left = Math.round(focus.x + focus.width / 2 - bodyX * scaleX + slideX);
            const top = Math.round(focus.y + focus.height / 2 - bodyY * scaleY + slideY);
            const width = Math.round(template.width * scaleX);
            const height = Math.round(template.height * scaleY);
            for (const [dx, dy] of shifts) {
              const box = { x: left + dx, y: top + dy, width, height };
              if (clippedOnly && !extendsPastCardSide(box, card, side)) continue;
              const score = cardPlacementScore(screen, template, box, card, mirrored, probes, true);
              if (score < 0.68) continue;
              shortlist.push({ template, box, mirrored, score });
              // A pose can be convincing on the full sample set even if it ranks lower on the coarse probes.
              const checked = cardPlacementScore(screen, template, box, card, mirrored, template.samples, false, true);
              if (checked >= (tightlyBounded ? 0.78 : 0.83)) verified.push(matchFromTemplate(template, box, checked, 'normalized', mirrored));
            }
          }
        }
      }
    }
    const step = Math.max(1, Math.round(Math.min(card.width, card.height) / 64));
    const refined = refineCardPlacements(screen, card, shortlist, candidateLimit, 'focus', step);
    const matches = rankSubject([...verified, ...refined], candidateLimit, tightlyBounded ? 0.78 : 0.83, tightlyBounded ? 0.78 : 0.83);
    if (matches.length) return matches;

    // Retry the same shortlist between the original search positions.
    const narrower = step > 1 && shortlist.length ? refineCardPlacements(screen, card, shortlist, candidateLimit, 'focus', Math.floor(step / 2)) : [];
    if (narrower.length) return narrower;
    if (!fineRecovery) {
      return preferredFocus?.offCenter && !clippedOnly
        ? searchFocusedCard(screen, card, ranked, foregroundRanks, candidateLimit, preferredFocus, false, true)
        : [];
    }
    return refineCardPlacements(screen, card, shortlist, candidateLimit, 'focus', 1, true);
  }

  function refineCardPlacements(screen, card, shortlist, candidateLimit, mode, step = Math.max(1, Math.round(Math.min(card.width, card.height) / 85)), fineRecovery = false) {
    shortlist.sort((a, b) => b.score - a.score);

    const candidates = [];
    const scoreFloor = candidateLimit > 1 ? 0.70 : 0.76;
    const refinements = [0.965, 0.985, 1, 1.015, 1.035].map(scale => [scale, scale]);
    if (mode === 'center') refinements.push([0.95, 1.05], [1.05, 0.95]);
    if (mode === 'focus') refinements.push([0.965, 1], [1, 0.965], [1.035, 1], [1, 1.035]);
    if (fineRecovery) refinements.push([1.01, 0.975], [0.975, 1.01], [1.025, 0.99], [0.99, 1.025]);
    const allowContrastShift = mode === 'center' || mode === 'focus';
    for (const { template, box, mirrored } of shortlist.slice(0, mode === 'focus' ? 48 : 210)) {
      let best;
      const dimensions = refinements.map(([x, y]) => [Math.round(box.width * x), Math.round(box.height * y)]);
      // A rounded resize may miss by one pixel even when the overall fit is correct.
      if (fineRecovery) dimensions.push([box.width - 1, box.height], [box.width + 1, box.height],
        [box.width, box.height - 1], [box.width, box.height + 1]);
      for (const [width, height] of dimensions) {
        for (let dx = -2; dx <= 2; dx += 1) {
          for (let dy = -2; dy <= 2; dy += 1) {
            const x = box.x + step * dx + Math.round((box.width - width) / 2);
            const y = box.y + step * dy + Math.round((box.height - height) / 2);
            const aligned = { x, y, width, height };
            const score = cardPlacementScore(screen, template, aligned, card, mirrored, template.samples, false, allowContrastShift);
            if (score >= scoreFloor && (!best || score > best.score)) best = matchFromTemplate(template, aligned, score, 'normalized', mirrored);
          }
        }
      }
      if (best) candidates.push(best);
    }
    const minimum = mode === 'focus' ? (fineRecovery ? 0.78 : 0.83) : 0.76;
    return rankSubject(candidates, candidateLimit, minimum, scoreFloor);
  }

  function refineCardWinner(screen, card, matches) {
    const winner = matches[0];
    if (!winner || winner.score >= 0.83) return matches;
    const geometry = matchGeometry.get(winner);
    if (!geometry) return matches;

    const { template, mirrored } = geometry;
    const step = Math.max(1, Math.round(Math.min(card.width, card.height) / 160));
    const adjustments = [0.96, 0.98, 0.99, 1, 1.01, 1.02, 1.04];
    let best = winner;
    // Pasted cards can stretch the source differently on each axis.
    for (const adjustX of adjustments) {
      for (const adjustY of adjustments) {
        const width = Math.round(winner.width * adjustX);
        const height = Math.round(winner.height * adjustY);
        const left = winner.x + Math.round((winner.width - width) / 2);
        const top = winner.y + Math.round((winner.height - height) / 2);
        for (const dx of [-step, 0, step]) {
          for (const dy of [-step, 0, step]) {
            const box = { x: left + dx, y: top + dy, width, height };
            const score = cardPlacementScore(screen, template, box, card, mirrored, template.samples, false);
            if (score > best.score) best = { ...box, score };
          }
        }
      }
    }
    if (best === winner) return matches;
    const originalScore = winner.score;
    const names = new Set([answerName(winner), ...(template.aliases ?? []).map(answerName)]);
    for (const match of [...matches, ...(winner.alternatives ?? [])]) {
      if (match.score === originalScore && names.has(answerName(match))) Object.assign(match, best);
    }
    return matches;
  }

  function searchCardSubject(screen, card, options, limit, focus, fineRecovery = false) {
    const ranked = rankCardTemplates(screen, focus, options);
    const foreground = rankCardForeground(screen, focus, ranked);
    return searchFocusedCard(screen, card, ranked, foreground, limit, focus, false, fineRecovery)
      .filter(match => coversCardFocus(match, focus));
  }

  function recognizeCardSubject(screen, card, options, limit, focus) {
    if (focus.offCenter) return searchCardSubject(screen, card, options, limit, focus);

    // A compact centered subject can be surrounded by bright card effects. Require
    // a convincing fit before using its shaded outline in place of the wider search.
    for (const region of [focus.ink, focus]) {
      if (!region) continue;
      const matches = searchCardSubject(screen, card, options, limit, region);
      const [best, rival] = matches;
      if (best?.score >= 0.92 && (!rival || best.score - rival.score >= 0.025)) return matches;
    }
    return [];
  }

  function recoverCardMatch(source, card, options, limit, previous, subjectFocus) {
    const previousScore = previous[0]?.score ?? 0;
    if (!card) return [];
    const preceding = previous[0];
    const template = preceding && matchGeometry.get(preceding)?.template;
    const littleInk = template && template.samples.filter(point => point.light <= 90).length < 0.08 * template.samples.length;
    const smallPatch = preceding && preceding.width * preceding.height < 0.18 * card.width * card.height;
    const suspect = Boolean(littleInk || smallPatch);
    if ((previousScore >= 0.88 && !suspect) || !hasOpaqueCardInterior(source, card)) return [];
    source.lightValues ??= Uint8Array.from(source.pixels, luminance);
    const screen = { ...source, approximate: true };

    // A disconnected cursor or panel edge should not enlarge the main sprite.
    const tightCard = options.card === true || hasCoolCardBorder(screen, card);
    const darkFocus = dominantDarkCardFocus(screen, card, tightCard || suspect);
    if (!darkFocus && !cardHasDetails(screen, card)) return [];
    const measured = tightCard && Math.min(card.width, card.height) <= 180 ? cardFocusBounds(screen, card) : null;
    const extra = measured && (!darkFocus || measured.width * measured.height > darkFocus.width * darkFocus.height * 1.10) ? measured : null;
    for (const candidate of [darkFocus, extra]) {
      if (!candidate) continue;
      const matches = searchCardSubject(screen, card, options, limit, candidate, true);
      const [best, rival] = matches;
      const priorCoversSubject = previous[0] && coversCardFocus(previous[0], candidate, 0.70, 0.65);
      const ungrounded = !priorCoversSubject || littleInk;
      const minimum = previousScore >= 0.88 && ungrounded ? 0.90
        : tightCard && !priorCoversSubject ? 0.78 : Math.max(0.83, previousScore + 0.025);
      if (best?.score >= minimum && coversCardFocus(best, candidate, 0.70, 0.65)
        && (!rival || best.score - rival.score >= 0.035)) {
        return best.score >= 0.92 ? matches : matches.map(match => ({ ...match, suggestion: true }));
      }
    }

    const focus = subjectFocus ?? cardSubjectFocus(screen, card);
    if (darkFocus || !focus || focus.width * focus.height > card.width * card.height * 0.5) return [];
    // Faded sprites have too little dark ink. Fit their composite art against the
    // background immediately around the connected strokes instead of the card edges.
    for (const fraction of [0.20, 0.12]) {
      const region = expandCardFocus(card, focus, fraction);
      const matches = recognizeTranslucentCard(screen, region, options, limit, focus);
      const best = matches[0];
      if (best?.score >= Math.max(0.91, previousScore + 0.025) && coversCardFocus(best, focus, 0.65, 0.65)) return matches;
    }
    return [];
  }

  function expandCardFocus(card, focus, fraction) {
    const pad = Math.max(6, Math.round(Math.min(focus.width, focus.height) * fraction));
    const x = Math.max(card.x, focus.x - pad);
    const y = Math.max(card.y, focus.y - pad);
    const right = Math.min(card.x + card.width, focus.x + focus.width + pad);
    const bottom = Math.min(card.y + card.height, focus.y + focus.height + pad);
    return { x, y, width: right - x, height: bottom - y };
  }

  function recognizeCard(source, card, options, candidateLimit, silhouette, preferredFocus, quietFocus) {
    source.lightValues ??= Uint8Array.from(source.pixels, luminance);
    const screen = { ...source, approximate: true };
    if (!silhouette && !cardHasDetails(screen, card)) return [];
    const localized = !silhouette && (preferredFocus === undefined ? cardSubjectFocus(screen, card) : preferredFocus);
    if (localized) {
      const matches = recognizeCardSubject(screen, card, options, candidateLimit, localized);
      if (localized.offCenter || matches.length) return matches;
    }
    const ranked = rankCardTemplates(screen, card, options, silhouette);
    const initial = ranked.slice(0, 480);
    let centered;
    // A large centered outline inside quiet margins can be verified with the smaller search.
    if (quietFocus && Math.min(card.width, card.height) >= 160 && clippedCardSides(card, quietFocus).length === 0
      && quietFocus.width >= card.width * 0.65 && quietFocus.height >= card.height * 0.65) {
      centered = refineCardWinner(screen, card, searchCardPlacements(screen, card, initial.slice(0, 240), candidateLimit, 'center'));
      const winner = centered[0];
      const rival = centered.find(match => answerName(match) !== answerName(winner));
      if (winner && winner.score >= 0.885 && coversCardFocus(winner, quietFocus) && (!rival || winner.score - rival.score >= 0.04)) {
        return centered;
      }
    }
    let first = refineCardWinner(screen, card, searchCardPlacements(screen, card, initial, candidateLimit));
    if (!silhouette && (first[0]?.score ?? 0) < 0.90) {
      const composite = recognizeTranslucentCard(screen, card, options, candidateLimit);
      const previousScore = first[0]?.score ?? 0;
      if ((composite[0]?.score ?? 0) >= Math.max(0.86, previousScore + 0.04)) first = composite;
    }
    if (!silhouette && (first[0]?.score ?? 0) < 0.80) {
      // Translucent lightning, glows, and other effects may be missing from a card.
      const core = refineCardWinner(screen, card, searchCardPlacements(screen, card, initial, candidateLimit, 'probes'));
      if ((core[0]?.score ?? 0) > (first[0]?.score ?? 0)) first = core;
    }
    if (!silhouette && (first[0]?.score ?? 0) < 0.80) {
      centered ??= refineCardWinner(screen, card, searchCardPlacements(screen, card, initial.slice(0, 240), candidateLimit, 'center'));
      if ((centered[0]?.score ?? 0) > (first[0]?.score ?? 0)) first = centered;
    }
    let foregroundRanks;
    if (!silhouette && (first[0]?.score ?? 0) < 0.85) {
      foregroundRanks = rankCardForeground(screen, card, ranked);
      const focused = searchFocusedCard(screen, card, ranked, foregroundRanks, candidateLimit);
      if ((focused[0]?.score ?? 0) >= Math.max(0.83, (first[0]?.score ?? 0) + 0.015)) first = focused;
    }
    if ((first[0]?.score ?? 0) >= 0.80 || ranked.length <= 480 || (silhouette && first.length)) return first;
    const remaining = ranked.slice(480);
    if (!silhouette) {
      const testedInitial = new Set(initial.map(({ template }) => template));
      const foreground = (foregroundRanks ?? rankCardForeground(screen, card, ranked))
        .filter(({ template }) => !testedInitial.has(template)).slice(0, 480);
      const match = refineCardWinner(screen, card, searchCardPlacements(screen, card, foreground, candidateLimit));
      if ((match[0]?.score ?? 0) > (first[0]?.score ?? 0)) first = match;
      if ((first[0]?.score ?? 0) >= 0.80) return first;
      const tested = new Set(foreground.map(({ template }) => template));
      const fallback = remaining.slice(0, 920).filter(({ template }) => !tested.has(template));
      const later = refineCardWinner(screen, card, searchCardPlacements(screen, card, fallback, candidateLimit));
      return (later[0]?.score ?? 0) > (first[0]?.score ?? 0) ? later : first;
    }
    return refineCardWinner(screen, card, searchCardPlacements(screen, card, remaining.slice(0, 920), candidateLimit));
  }

  function recognizeClippedCard(source, card, options, limit, { focus: existingFocus, early = false, transparentCard = false } = {}) {
    if (!hasOpaqueCardCorners(source, card)) {
      // Bilinear resizing can soften the first pixel of an otherwise opaque card border.
      const inset = { x: card.x + 1, y: card.y + 1, width: card.width - 2, height: card.height - 2 };
      if (!transparentCard || !hasOpaqueCardCorners(source, inset)) return [];
    }
    source.lightValues ??= Uint8Array.from(source.pixels, luminance);
    const screen = { ...source, approximate: true };
    if (!cardHasDetails(screen, card)) return [];
    const focus = existingFocus ?? cardFocusBounds(screen, card);
    if (!focus) return [];
    const sides = clippedCardSides(card, focus);
    // A noisy field that reaches all four edges provides no clear axis to recover.
    if (sides.length < (transparentCard && !early ? 1 : 2) || sides.length === 4) return [];
    if (early && (focus.width < card.width * 0.70 || focus.height < card.height * 0.70
      || !sides.some(side => side === 'left' || side === 'right')
      || !sides.some(side => side === 'top' || side === 'bottom'))) return [];
    const recovery = transparentCard && !early;
    if (recovery && sides.length === 2) {
      const tolerance = Math.max(2, Math.round(Math.min(card.width, card.height) * 0.022)) + 1;
      const near = [
        ['left', focus.x - card.x], ['top', focus.y - card.y],
        ['right', card.x + card.width - focus.x - focus.width],
        ['bottom', card.y + card.height - focus.y - focus.height],
      ].filter(([side, gap]) => !sides.includes(side) && gap <= tolerance);
      if (near.length === 1) sides.push(near[0][0]);
    }
    const ranked = rankCardTemplates(screen, card, options);
    const foreground = rankCardForeground(screen, card, ranked);
    const matches = searchFocusedCard(screen, card, ranked, foreground, limit, focus, true, recovery, sides);
    const minimum = early ? 0.91 : recovery ? 0.83 : 0.88;
    return matches.filter(match => match.score >= minimum && coversCardFocus(match, focus)
      && sides.some(side => extendsPastCardSide(match, card, side)));
  }

  function recognizeCardPanel(screen, panel, options, limit, transparentCard = false) {
    screen.lightValues ??= Uint8Array.from(screen.pixels, luminance);
    const focus = cardFocusBounds(screen, panel);
    // A corner touch alone can be a complete pose. Try the normal search first in that case.
    const prioritizeClipping = focus && clippedCardSides(panel, focus).length === 3;
    if (prioritizeClipping) {
      const clipped = recognizeClippedCard(screen, panel, options, limit, { focus, early: true, transparentCard });
      if (clipped.length) return clipped;
    }
    const card = recognizeCard(screen, panel, options, limit);
    if (!prioritizeClipping && focus && (!(card[0]?.score >= 0.91) || !coversCardFocus(card[0], focus))) {
      const clipped = recognizeClippedCard(screen, panel, options, limit, { focus, early: true });
      if (clipped.length) return clipped;
    }
    if ((card[0]?.score ?? 0) < SCORE_FLOOR) {
      const recovered = recognizeClippedCard(screen, panel, options, limit, { focus, transparentCard });
      if (recovered.length) return recovered;
    }
    return card;
  }

  function retryCardSampling(screen, card, options) {
    if (options.retrySampling === false || Math.max(card.width, card.height) > 450
      || !hasOpaqueCardInterior(screen, card)) return [];
    screen.lightValues ??= Uint8Array.from(screen.pixels, luminance);
    const ink = dominantDarkCardFocus(screen, card, true);
    const measured = cardSubjectFocus(screen, card) ?? cardFocusBounds(screen, card);
    const focus = ink && (!measured || measured.width * measured.height <= 1.55 * ink.width * ink.height) ? ink : measured;
    if (!focus || focus.width * focus.height < 0.08 * card.width * card.height) return [];

    // On a blurred or very small capture, the ordinary sampling grid can miss a
    // thin outline. Try the same pixels at a few bounded, nearest-neighbor grids.
    const narrower = expandCardFocus(card, focus, 0.14);
    const trials = [
      { region: card, scale: 1.25 }, { region: card, scale: 1.25, alternateGrid: true },
      { region: card, scale: 1.5 }, { region: card, scale: 0.8 },
    ];
    if (narrower.width * narrower.height <= 0.85 * card.width * card.height) trials.push({ region: narrower, scale: 1 });
    for (const { region, scale, alternateGrid } of trials) {
      const width = Math.round(region.width * scale);
      const height = Math.round(region.height * scale);
      const grid = (size, count) => {
        const stride = size / count;
        let position = 0.5 * stride;
        return Uint16Array.from({ length: count }, (_, index) => {
          const coordinate = alternateGrid ? position : (index + 0.5) * size / count;
          position += stride;
          return Math.floor(coordinate);
        });
      };
      const columns = grid(region.width, width);
      const rows = grid(region.height, height);
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        const row = (region.y + rows[y]) * screen.width;
        for (let x = 0; x < width; x += 1) {
          const pixel = screen.pixels[row + region.x + columns[x]];
          const index = 4 * (y * width + x);
          rgba[index] = pixel & 255;
          rgba[index + 1] = (pixel >>> 8) & 255;
          rgba[index + 2] = (pixel >>> 16) & 255;
          rgba[index + 3] = pixel >>> 24;
        }
      }
      const matches = recognizeSingle({ rgba, width, height, options: { ...options, card: false, retrySampling: false } });
      const [best, rival] = matches;
      if (!(best?.score >= 0.78) || (rival && best.score - rival.score < 0.025)) continue;
      const scaleX = region.width / width;
      const scaleY = region.height / height;
      const mapped = matches.map(match => {
        const restored = {
          ...match,
          x: region.x + Math.round(match.x * scaleX),
          y: region.y + Math.round(match.y * scaleY),
          width: Math.round(match.width * scaleX),
          height: Math.round(match.height * scaleY),
        };
        if (best.score < 0.87) restored.suggestion = true;
        if (matchGeometry.has(match)) matchGeometry.set(restored, matchGeometry.get(match));
        return restored;
      });
      const lead = mapped[0];
      const x = Math.max(lead.x, card.x);
      const y = Math.max(lead.y, card.y);
      const right = Math.min(lead.x + lead.width, card.x + card.width);
      const bottom = Math.min(lead.y + lead.height, card.y + card.height);
      const visible = { x, y, width: right - x, height: bottom - y };
      if (coversCardFocus(visible, focus, 0.62, 0.52)) return mapped;
    }
    return [];
  }

  function recoverCardSpatialPatch(screen, card, match, options, limit) {
    const cardArea = card.width * card.height;
    if (cardArea > 200_000 || match.width * match.height > 0.12 * cardArea
      || !hasOpaqueCardInterior(screen, card)) return [];

    // A tight crop can lose the card border while a small, bright patch still matches.
    screen.lightValues ??= Uint8Array.from(screen.pixels, luminance);
    const focus = cardFocusBounds(screen, card);
    if (!focus || focus.width * focus.height < 0.60 * cardArea) return [];
    const ink = dominantDarkCardFocus(screen, card, true);
    if (!ink || !coversCardFocus(ink, focus, 0.60, 0.85) || coversCardFocus(match, ink, 0.35)) return [];

    const panel = recognizeCardPanel(screen, card, options, limit, true)
      .filter(candidate => coversCardFocus(candidate, focus, 0.72, 0.75) && coversCardFocus(candidate, ink, 0.75, 0.60));
    return (panel[0]?.score ?? 0) >= 0.85 ? panel : [];
  }

  function recognizeSingle(message) {
    const { rgba, width, height, options } = message;
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(SUBJECT_CANDIDATE_LIMIT, options.limit)) : 1;
    const screen = { pixels: screenshotPixels(rgba, width, height), width, height };
    const subject = foregroundBox(screen);
    if (subject?.empty) return [];
    const candidates = [];
    let opaqueFocus;
    let subjectFocus;
    let suggestions = [];
    const coverage = subject ? subject.signature.reduce((sum, cell) => sum + cell, 0) / (SIGNATURE_SIDE ** 2 * 4) : 0;

    if (subject?.transparent) {
      const opaque = opaqueAlphaPanel(screen, subject.box);
      const panel = opaque ?? (coverage >= 0.97 ? subject.box : null);
      if (panel) {
        const card = recognizeCardPanel(screen, panel, options, limit, true);
        const recovered = recoverCardMatch(screen, panel, { ...options, card: true }, limit, card);
        if (recovered.length) return recovered;
        if (card.length) return completeSubject(screen, { ...subject, box: panel }, options, card, limit);
        const retry = retryCardSampling(screen, panel, options);
        if (retry.length) return retry;
      }
    }
    const matteCard = inferredMatteCard(screen, subject, coverage);
    const useWholeImage = !subject || options.card === true;
    const region = matteCard ?? (useWholeImage ? { x: 0, y: 0, width, height } : null);
    const coolBorder = region && hasCoolCardBorder(screen, region);
    const bounded = Boolean(matteCard) || options.card === true || Boolean(coolBorder);
    // A card already isolated by the uploader should match the exact same pixels
    // whether it arrived with transparent padding or a solid matte.
    if (region && !subject?.transparent && options.card === true) {
      const panel = recognizeCardPanel(screen, region, options, limit, true);
      if ((panel[0]?.score ?? 0) >= SCORE_FLOOR) {
        const recovered = recoverCardMatch(screen, region, options, limit, panel);
        return recovered.length ? recovered : completeSubject(screen, { box: region }, options, panel, limit);
      }
    }
    const opaqueCard = region && opaqueCardBounds(screen, region, bounded);
    if (opaqueCard) {
      if (!cardHasDetails(screen, opaqueCard)) return [];
      const focus = cardSubjectFocus(screen, opaqueCard);
      subjectFocus = focus;
      const localized = focus?.offCenter ? focus : null;
      if (focus && !localized) {
        const matches = recognizeCardSubject({ ...screen, approximate: true }, opaqueCard, options, limit, focus);
        if (matches.length) {
          const recovered = recoverCardMatch(screen, opaqueCard, options, limit, matches, focus);
          return recovered.length ? recovered : completeSubject(screen, { box: opaqueCard }, options, matches, limit);
        }
      }
      opaqueFocus = localized ?? cardFocusBounds(screen, opaqueCard);
      if (!opaqueFocus) return [];
      const substantial = opaqueFocus.width * opaqueFocus.height >= 0.10 * opaqueCard.width * opaqueCard.height;
      if (!substantial && options.card === true) return [];
      if (substantial) {
        const card = recognizeCard(screen, opaqueCard, options, limit, undefined, localized, opaqueFocus)
          .filter(match => coversCardFocus(match, opaqueFocus));
        if ((card[0]?.score ?? 0) >= (bounded ? SCORE_FLOOR : 0.83)) {
          const recovered = recoverCardMatch(screen, opaqueCard, options, limit, card, subjectFocus);
          if (recovered.length) return recovered;
          return completeSubject(screen, { box: opaqueCard }, options, card, limit);
        }
        if (options.suggestions) suggestions = card.map(match => ({ ...match, suggestion: true }));
      }
    }
    if (region && !subject?.transparent) {
      if (coolBorder && options.card !== true) {
        const panel = recognizeCardPanel(screen, region, options, limit, true);
        if ((panel[0]?.score ?? 0) >= SCORE_FLOOR) {
          const recovered = recoverCardMatch(screen, region, options, limit, panel, subjectFocus);
          return recovered.length ? recovered : completeSubject(screen, { box: region }, options, panel, limit);
        }
      }
      const clipped = recognizeClippedCard(screen, region, options, limit, { focus: opaqueFocus });
      if (clipped.length) return completeSubject(screen, { box: region }, options, clipped, limit);
    }

    if (subject && !opaqueFocus) {
      const scoreFloor = limit > 1 ? 0.77 : 0.84;
      for (const template of templates) {
        if (options.entityType && options.entityType !== template.entry.type) continue;
        const box = subject.box;
        const aspectRatioChange = (box.width * template.height) / (box.height * template.width);
        if (aspectRatioChange < 0.79 || aspectRatioChange > 1.27) continue;
        for (const mirrored of [false, true]) {
          const shapeScore = silhouetteScore(subject.signature, template.silhouette, mirrored);
          if (shapeScore < (subject.transparent ? 0.67 : 0.62)) continue;
          const score = normalizedColorScore(screen, { box, template, mirrored, foreground: subject.foreground }, shapeScore);
          if (score >= scoreFloor) candidates.push(matchFromTemplate(template, box, score, 'normalized', mirrored));
        }
      }
      const matched = rankSubject(candidates, limit, 0.84, scoreFloor);
      if (matched.length) return completeSubject(screen, subject, options, matched, limit);
      if (options.suggestions) {
        suggestions = rankSubject(candidates, limit, scoreFloor, scoreFloor).map(match => ({ ...match, suggestion: true }));
      }
      if (subject.transparent) return suggestions;
      const adjusted = recognizeCard(screen, subject.box, options, limit, subject.signature);
      if (adjusted.length) return completeSubject(screen, subject, options, adjusted, limit);
      candidates.length = 0;
    }

    // Native crops often match straight away, even when their background is busy.
    const spatial = recognizeMessage({ ...message, options: {
      ...options, single: false, rejectWeakDark: true, limit: 3, includeSubjectAlternates: limit > 1,
    } });
    const spatialMatch = (opaqueFocus ? spatial.find(match => coversCardFocus(match, opaqueFocus)) : spatial[0]) ?? null;
    if ((spatialMatch?.score ?? 0) >= 0.88) {
      if (region && !subject && !opaqueFocus && !bounded) {
        const panel = recoverCardSpatialPatch(screen, region, spatialMatch, options, limit);
        if (panel.length) return completeSubject(screen, { box: region }, options, panel, limit);
      }
      const recovered = recoverCardMatch(screen, region, options, limit, [spatialMatch], subjectFocus);
      if (recovered.length) return recovered;
      return completeSubject(screen, subject, options, rankSubject([spatialMatch], limit, 0.88, SCORE_FLOOR), limit);
    }
    for (const template of templates) {
      if (template.darkSilhouette || (options.entityType && options.entityType !== template.entry.type)) continue;
      const placements = cropPlacements(screen, template);
      for (const mirrored of [false, true]) {
        for (const box of placements) {
          if (opaqueFocus && !coversCardFocus(box, opaqueFocus)) continue;
          const score = normalizedColorScore(screen, { box, template, mirrored });
          if (score >= (limit > 1 ? 0.80 : 0.87)) candidates.push(matchFromTemplate(template, box, score, 'normalized', mirrored));
        }
      }
    }
    if (spatialMatch) candidates.push(spatialMatch);
    const matched = rankSubject(candidates, limit, 0.87, SCORE_FLOOR, spatialMatch);
    const recovered = recoverCardMatch(screen, region, options, limit, matched.length ? matched : suggestions, subjectFocus);
    if (recovered.length) return recovered;
    if (!matched.length && bounded && region) {
      const retry = retryCardSampling(screen, region, options);
      if (retry.length) return retry;
    }
    return matched.length ? completeSubject(screen, subject, options, matched, limit) : suggestions;
  }

  function distinguishSimilarSilhouettes({ rgba, width, height }, matches) {
    const first = matches[0];
    const reference = first && matchGeometry.get(first);
    if (!reference || matches.length < 2 || first.suggestion || first.score < 0.84 || first.method !== 'normalized') return matches;
    const { x, y, width: boxWidth, height: boxHeight } = first;
    const shorterSide = Math.min(boxWidth, boxHeight);
    if (shorterSide < 48 || x < 0 || y < 0 || x + boxWidth > width || y + boxHeight > height) return matches;

    const { template, mirrored } = reference;
    if (template.translucent) return matches;
    const tolerance = Math.max(2, shorterSide * 0.025);
    const family = matches.filter(match => {
      const geometry = matchGeometry.get(match);
      return geometry && !match.suggestion && match.method === first.method && match.type === first.type
        && match.score >= Math.max(SCORE_FLOOR, first.score - 0.045) && geometry.mirrored === mirrored
        && !geometry.template.translucent && geometry.template.width === template.width && geometry.template.height === template.height
        && Math.abs(match.x - x) <= tolerance && Math.abs(match.y - y) <= tolerance
        && Math.abs(match.width - boxWidth) <= tolerance && Math.abs(match.height - boxHeight) <= tolerance
        && silhouetteScore(template.silhouette, geometry.template.silhouette, false) >= 0.94;
    });
    if (family.length < 2) return matches;

    const side = SIGNATURE_SIDE;
    const cells = side * side;
    const profiles = family.map(match => matchGeometry.get(match).template.silhouette);
    const pixels = screenshotPixels(rgba, width, height);
    const sideSamples = 8;
    const samplesPerCell = sideSamples * sideSamples;
    const samples = new Uint8Array(cells * samplesPerCell);
    const outside = new Uint16Array(256);
    const inside = new Uint16Array(256);
    let outsideCount = 0;
    let insideCount = 0;
    let varied = 0;
    let translucent = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const column = cell % side;
      const row = Math.floor(cell / side);
      const displayedColumn = mirrored ? side - 1 - column : column;
      const values = profiles.map(profile => profile[cell]);
      const exterior = values.every(value => value === 0);
      const interior = values.every(value => value === 4);
      if (values.some(value => value !== values[0])) varied += 1;
      for (let dy = 0; dy < sideSamples; dy += 1) {
        const yy = y + Math.floor((row + (dy + 0.5) / sideSamples) * boxHeight / side);
        for (let dx = 0; dx < sideSamples; dx += 1) {
          const xx = x + Math.floor((displayedColumn + (dx + 0.5) / sideSamples) * boxWidth / side);
          const pixel = pixels[yy * width + xx];
          if ((pixel >>> 24) < 224) translucent += 1;
          const light = Math.round(((pixel & 255) + ((pixel >>> 8) & 255) + ((pixel >>> 16) & 255)) / 3);
          samples[cell * samplesPerCell + dy * sideSamples + dx] = light;
          if (exterior) { outside[light] += 1; outsideCount += 1; }
          if (interior) { inside[light] += 1; insideCount += 1; }
        }
      }
    }
    if (varied < 2 || outsideCount < 6 * samplesPerCell || insideCount < 6 * samplesPerCell
      || translucent > samples.length * 0.03) return matches;

    const quantile = (counts, target) => {
      let seen = 0;
      return counts.findIndex(count => (seen += count) >= target);
    };
    const backdrop = quantile(outside, outsideCount * 0.10);
    const foreground = quantile(inside, insideCount * 0.75);
    if (backdrop - foreground < 36) return matches;

    // Same-shaped variants can differ only in a hat or another small detail.
    // Verify the outline at one shared placement over several contrast cutoffs.
    const cutoffs = [backdrop - 4, backdrop - 8, backdrop - 14];
    const disagreement = new Float64Array(family.length);
    let winner;
    for (const cutoff of cutoffs) {
      const errors = new Float64Array(family.length);
      for (let cell = 0; cell < cells; cell += 1) {
        const start = cell * samplesPerCell;
        let occupied = 0;
        for (let i = start; i < start + samplesPerCell; i += 1) occupied += Number(samples[i] < cutoff);
        const fill = occupied / samplesPerCell;
        profiles.forEach((profile, index) => { errors[index] += Math.abs(fill - profile[cell] / 4); });
      }
      const order = Array.from(errors.keys()).sort((a, b) => errors[a] - errors[b]);
      const best = order[0];
      if (errors[best] > cells * 0.13 || errors[order[1]] - errors[best] < 0.22
        || (winner !== undefined && winner !== best)) return matches;
      winner = best;
      errors.forEach((error, index) => { disagreement[index] += error - errors[best]; });
    }
    if (winner === 0) return matches;

    // Only lower scores contradicted by the outline. The verified candidate
    // keeps its measured appearance score, including the display floor.
    const penalties = new Map(family.map((match, index) => [match,
      Math.min(0.075, 0.60 * disagreement[index] / (varied * cutoffs.length))]));
    const rescored = matches.map(match => ({ ...match, score: match.score - (penalties.get(match) ?? 0) }));
    rescored.sort(compareMatches);
    return answerName(rescored[0]) === answerName(family[winner]) ? rescored : matches;
  }

  function recognizeMessage(message) {
    const { rgba, width, height } = message;
    const options = message.options ?? {};
    if (options.single) return distinguishSimilarSilhouettes(message, recognizeSingle(message));
    if (options.jpeg) return recognize(indexScreen(rgba, width, height, true), options);
    const exact = recognize(indexScreen(rgba, width, height, false), options);
    const strong = exact.filter(match => match.score >= 0.9);
    if (strong.length >= 3) return exact;
    const tolerant = recognize(indexScreen(rgba, width, height, true), options);
    if (!tolerant.length) return exact;
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(30, options.limit)) : 10;
    return rankMatches([...strong, ...tolerant], limit, options.includeSubjectAlternates);
  }

  async function initialize(message) {
    let input = message.entries;
    if (message.packedIndex) input = readMapleIndex(message.entries, message.packedIndex);
    else if (message.packedTemplates) input = readMapleTemplates(message.entries, message.packedTemplates);
    const indexed = [];
    const preparedByType = new WeakMap();
    exactColors = new Map();
    let entryCount = 0;
    let entryIndex = 0;
    let frameCount = 0;
    for await (const item of input) {
      const { templates: frames, preparedFrames, ...entry } = item;
      const previousCount = frameCount;
      if (preparedFrames) {
        for (const frame of preparedFrames) {
          let categories = preparedByType.get(frame);
          if (!categories) {
            categories = new Map();
            preparedByType.set(frame, categories);
          }
          const canonical = categories.get(entry.type);
          if (canonical) {
            if (canonical.aliases.length < SUBJECT_CANDIDATE_LIMIT - 1 && !sameName(canonical.entry, entry)
              && !canonical.aliases.some(alias => sameName(alias, entry))) canonical.aliases.push(entry);
          } else {
            frame.anchors.forEach(registerAnchor);
            const template = addRuntimeFeatures({ ...frame, entry, aliases: [] });
            categories.set(entry.type, template);
            indexed.push(template);
          }
          frameCount += 1;
        }
      } else {
        for (const frame of frames ?? []) {
          const template = compactTemplate(frame, entry);
          if (!template) continue;
          indexed.push(addRuntimeFeatures(template));
          onPrepared?.(entryIndex, template);
          frameCount += 1;
        }
      }
      if (frameCount > previousCount) entryCount += 1;
      entryIndex += 1;
    }
    templates = indexed;
    translucentTemplates = indexed.filter(template => template.translucent);
    logicalTemplateCount = frameCount;
    return { entryCount, templateCount: frameCount };
  }

  self.onmessage = async ({ data: message }) => {
    try {
      if (message.type === 'init') {
        self.postMessage({ type: 'ready', ...await initialize(message) });
      } else if (message.type === 'recognize') {
        const matches = recognizeMessage(message);
        self.postMessage({ type: 'result', requestId: message.requestId, width: message.width, height: message.height, matches });
      }
    } catch (error) {
      const fallback = message.type === 'init' ? '無法載入圖鑑資料。' : '無法辨識這張圖片。';
      const detail = /\p{Script=Han}/u.test(error?.message) ? error.message : fallback;
      self.postMessage({ type: 'error', requestId: message.requestId, message: detail });
    }
  };
}
