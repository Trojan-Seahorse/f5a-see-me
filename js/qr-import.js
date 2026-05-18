(function () {
  "use strict";

  const WEB_LONG_IMAGE = { qrSize: 800, padding: 8, textSize: 22, textGap: 8 };
  const APP_LONG_IMAGE = { qrSize: 768, padding: 24, textSize: 22, textGap: 12 };

  async function decodeQrTextFromImage(image, options) {
    const {
      magic,
      parseChunkText,
      normalizeChunkText,
      chunkGroupKey,
      onProgress
    } = options || {};
    if (typeof window.jsQR !== "function") throw new Error("jsQR 未加载");
    if (!magic || typeof parseChunkText !== "function" || typeof normalizeChunkText !== "function" || typeof chunkGroupKey !== "function") {
      throw new Error("二维码导入模块缺少协议解析器");
    }

    const canvas = document.createElement("canvas");
    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    const maxScanWidth = 1600;
    const scaleDown = srcW > maxScanWidth ? maxScanWidth / srcW : 1;
    canvas.width = Math.max(1, Math.round(srcW * scaleDown));
    canvas.height = Math.max(1, Math.round(srcH * scaleDown));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const found = new Set();
    const byGroup = new Map();
    let completeGroupKey = null;
    const yieldFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const startedAt = performance.now();
    const scanTimeBudgetMs = 7000;
    let scanCount = 0;

    const recognizedCount = () => {
      let count = 0;
      byGroup.forEach((g) => { count += g.texts.size; });
      return count;
    };
    const report = (phase) => {
      if (typeof onProgress === "function") onProgress(`${phase}（已识别 ${recognizedCount()} 个分片）`);
    };
    const registerChunk = (parsed, yHint = null) => {
      const key = chunkGroupKey(parsed);
      if (!byGroup.has(key)) byGroup.set(key, { total: parsed.total, indices: new Set(), texts: new Set(), positions: new Map() });
      const group = byGroup.get(key);
      if (!group.texts.has(parsed.text)) {
        group.texts.add(parsed.text);
        group.indices.add(parsed.index);
        if (Number.isFinite(yHint) && !group.positions.has(parsed.index)) {
          group.positions.set(parsed.index, Number(yHint));
        }
      }
      if (group.indices.size >= group.total) completeGroupKey = key;
    };
    const bestGroupInfo = () => {
      let bestKey = null;
      let best = null;
      byGroup.forEach((group, key) => {
        if (!best) {
          best = group;
          bestKey = key;
          return;
        }
        const bestCoverage = best.total > 0 ? best.indices.size / best.total : 0;
        const curCoverage = group.total > 0 ? group.indices.size / group.total : 0;
        if (curCoverage > bestCoverage || (curCoverage === bestCoverage && group.indices.size > best.indices.size)) {
          best = group;
          bestKey = key;
        }
      });
      return best ? { key: bestKey, group: best } : null;
    };
    const tryRegisterDecodedText = (rawText, yHint = null) => {
      if (!rawText || typeof rawText !== "string") return;
      if (!rawText.includes(`${magic}|`)) return;
      const text = normalizeChunkText(rawText);
      if (!text || found.has(text)) return;
      found.add(text);
      const parsed = parseChunkText(text);
      if (parsed) registerChunk(parsed, yHint);
    };
    const barcodeDetector = (() => {
      try {
        if (typeof window.BarcodeDetector === "function") {
          return new window.BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch (_) {}
      return null;
    })();
    const tryDetectByBarcodeDetector = async (sourceCanvas, yHint = null) => {
      if (!barcodeDetector || !sourceCanvas) return;
      try {
        const codes = await barcodeDetector.detect(sourceCanvas);
        (codes || []).forEach((c) => tryRegisterDecodedText(c.rawValue || "", yHint));
      } catch (_) {}
    };
    const decodeSquare = (x, y, size) => {
      if (size <= 16) return;
      const sx = Math.max(0, Math.floor(x));
      const sy = Math.max(0, Math.floor(y));
      const sw = Math.min(canvas.width - sx, Math.floor(size));
      const sh = Math.min(canvas.height - sy, Math.floor(size));
      if (sw <= 16 || sh <= 16) return;
      const imgData = ctx.getImageData(sx, sy, sw, sh);
      const decoded = window.jsQR(imgData.data, sw, sh, { inversionAttempts: "attemptBoth" });
      if (decoded && decoded.data) tryRegisterDecodedText(decoded.data, sy);
    };
    const decodeRegion = (x, y, width, height, yHint = null) => {
      const sx = Math.max(0, Math.floor(x));
      const sy = Math.max(0, Math.floor(y));
      const sw = Math.min(canvas.width - sx, Math.floor(width));
      const sh = Math.min(canvas.height - sy, Math.floor(height));
      if (sw <= 16 || sh <= 16) return;
      const src = ctx.getImageData(sx, sy, sw, sh);
      const tryDecodeData = (data, dw, dh) => {
        const decoded = window.jsQR(data, dw, dh, { inversionAttempts: "attemptBoth" });
        if (decoded && decoded.data) {
          tryRegisterDecodedText(decoded.data, Number.isFinite(yHint) ? yHint : sy);
          return true;
        }
        return false;
      };

      if (tryDecodeData(src.data, sw, sh)) return;

      const target = Math.max(sw, sh);
      if (sw !== sh && target <= 2200) {
        const square = document.createElement("canvas");
        square.width = target;
        square.height = target;
        const sctx = square.getContext("2d", { willReadFrequently: true });
        sctx.imageSmoothingEnabled = false;
        sctx.fillStyle = "#ffffff";
        sctx.fillRect(0, 0, target, target);
        const tmp = document.createElement("canvas");
        tmp.width = sw;
        tmp.height = sh;
        const tctx = tmp.getContext("2d", { willReadFrequently: true });
        tctx.putImageData(src, 0, 0);
        sctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, target, target);
        const squareData = sctx.getImageData(0, 0, target, target);
        if (tryDecodeData(squareData.data, target, target)) return;
      }

      const thresholds = [96, 128, 160, 184];
      for (const t of thresholds) {
        const data = new Uint8ClampedArray(src.data);
        for (let i = 0; i < data.length; i += 4) {
          const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          const v = gray >= t ? 255 : 0;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
        if (tryDecodeData(data, sw, sh)) return;
      }
    };

    const w = canvas.width;
    const h = canvas.height;
    const designWidth = WEB_LONG_IMAGE.qrSize + WEB_LONG_IMAGE.padding * 2;
    const scale = w / designWidth;
    const scaledPadding = Math.max(1, Math.round(WEB_LONG_IMAGE.padding * scale));
    const scaledQrSize = Math.max(1, Math.round(WEB_LONG_IMAGE.qrSize * scale));
    const scaledTextGap = Math.max(1, Math.round(WEB_LONG_IMAGE.textGap * scale));
    const scaledTextSize = Math.max(1, Math.round(WEB_LONG_IMAGE.textSize * scale));
    const pageHeight = scaledPadding + scaledQrSize + scaledTextGap + scaledTextSize + scaledPadding;
    const safeLeft = Math.min(scaledPadding, Math.max(0, w - 1));
    const cropWidth = Math.min(scaledQrSize, w - safeLeft);
    const timeExceeded = () => (performance.now() - startedAt) > scanTimeBudgetMs;

    const tryDecodeAtTop = (qrTop) => {
      if (cropWidth <= 16) return;
      if (qrTop < 0 || qrTop >= h) return;
      const cropSize = Math.min(cropWidth, h - qrTop);
      if (cropSize <= 16) return;
      decodeSquare(safeLeft, qrTop, cropSize);
    };
    const tryDecodeAtTopRobust = (qrTop, xAdjust = 0) => {
      if (cropWidth <= 16) return;
      if (qrTop < 0 || qrTop >= h) return;
      const left = Math.max(0, Math.min(w - 1, safeLeft + xAdjust));
      const cropSize = Math.min(cropWidth, w - left, h - qrTop);
      if (cropSize <= 16) return;

      decodeSquare(left, qrTop, cropSize);
      if (completeGroupKey) return;

      const sx = Math.floor(left);
      const sy = Math.floor(qrTop);
      const sw = Math.floor(cropSize);
      const sh = Math.floor(cropSize);
      if (sw <= 16 || sh <= 16) return;
      const src = ctx.getImageData(sx, sy, sw, sh);

      const thresholds = [96, 128, 160, 184];
      for (const t of thresholds) {
        const data = new Uint8ClampedArray(src.data);
        for (let i = 0; i < data.length; i += 4) {
          const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          const v = gray >= t ? 255 : 0;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
        const decoded = window.jsQR(data, sw, sh, { inversionAttempts: "attemptBoth" });
        if (decoded && decoded.data) {
          tryRegisterDecodedText(decoded.data);
          if (completeGroupKey) return;
        }
      }

      const up = document.createElement("canvas");
      up.width = sw * 2;
      up.height = sh * 2;
      const upCtx = up.getContext("2d", { willReadFrequently: true });
      upCtx.imageSmoothingEnabled = false;
      const tmp = document.createElement("canvas");
      tmp.width = sw;
      tmp.height = sh;
      const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });
      tmpCtx.putImageData(src, 0, 0);
      upCtx.drawImage(tmp, 0, 0, up.width, up.height);
      const upData = upCtx.getImageData(0, 0, up.width, up.height);
      const upDecoded = window.jsQR(upData.data, up.width, up.height, { inversionAttempts: "attemptBoth" });
      if (upDecoded && upDecoded.data) {
        tryRegisterDecodedText(upDecoded.data);
      }
    };
    const scanLongImageLayout = async (layout, phaseLabel) => {
      const layoutDesignWidth = layout.qrSize + layout.padding * 2;
      const layoutScale = w / layoutDesignWidth;
      const layoutPadding = Math.max(1, Math.round(layout.padding * layoutScale));
      const layoutQrSize = Math.max(1, Math.round(layout.qrSize * layoutScale));
      const layoutTextGap = Math.max(1, Math.round(layout.textGap * layoutScale));
      const layoutTextSize = Math.max(1, Math.round(layout.textSize * layoutScale));
      const layoutPageHeight = layoutPadding + layoutQrSize + layoutTextGap + layoutTextSize + layoutPadding;
      const layoutLeft = Math.min(layoutPadding, Math.max(0, w - 1));
      const layoutCropWidth = Math.min(layoutQrSize, w - layoutLeft);
      const decodeLayoutTop = (qrTop, xAdjust = 0, robust = false) => {
        const prevSafeLeft = safeLeft;
        const left = Math.max(0, Math.min(w - 1, layoutLeft + xAdjust));
        const size = Math.min(layoutCropWidth, w - left, h - qrTop);
        if (robust) {
          tryDecodeAtTopRobust(qrTop, left - prevSafeLeft);
        } else if (size > 16) {
          decodeSquare(left, qrTop, size);
        }
      };
      let firstY = -1;
      const locateStep = layoutPadding;
      for (let y = 0; firstY < 0 && y + layoutPadding + layoutQrSize <= h; y += locateStep) {
        decodeLayoutTop(y + layoutPadding);
        scanCount++;
        if (completeGroupKey) return true;
        const best = bestGroupInfo();
        if (best && best.group.indices.size > 0) firstY = y + layoutPadding;
        if (scanCount % 10 === 0) {
          report(phaseLabel);
          await yieldFrame();
        }
        if (timeExceeded()) return false;
      }
      if (firstY < 0) return false;

      const tolerance = Math.max(16, Math.round(50 * layoutScale));
      const toleranceStep = Math.max(4, Math.floor(layoutPadding / 2));
      for (let page = 1; !timeExceeded(); page++) {
        const expectedY = firstY + page * layoutPageHeight;
        if (expectedY - tolerance >= h) break;
        for (let off = -tolerance; off <= tolerance; off += toleranceStep) {
          decodeLayoutTop(expectedY + off);
          scanCount++;
          if (completeGroupKey) return true;
          if (scanCount % 10 === 0) {
            report(phaseLabel);
            await yieldFrame();
          }
          if (timeExceeded()) return false;
        }
        if (page > 64) break;
      }

      const best = bestGroupInfo();
      if (!completeGroupKey && best && best.group.total > 1 && best.group.total <= 64 && !timeExceeded()) {
        const missing = [];
        for (let idx = 1; idx <= best.group.total; idx++) {
          if (!best.group.indices.has(idx)) missing.push(idx);
        }
        const yOffsets = [0, Math.round(layoutPadding * 0.5), -Math.round(layoutPadding * 0.5), layoutPadding, -layoutPadding];
        const xOffsets = [0, Math.round(layoutPadding * 0.3), -Math.round(layoutPadding * 0.3)];
        for (const idx of missing) {
          const expectedY = firstY + (idx - 1) * layoutPageHeight;
          for (const yo of yOffsets) {
            for (const xo of xOffsets) {
              decodeLayoutTop(expectedY + yo, xo, true);
              scanCount++;
              if (completeGroupKey) return true;
              if (scanCount % 8 === 0) {
                await yieldFrame();
                if (timeExceeded()) return false;
              }
            }
          }
        }
      }
      return completeGroupKey != null;
    };
    const detectQrCandidateRegions = async () => {
      const image = ctx.getImageData(0, 0, w, h);
      const data = image.data;
      const rowDark = new Uint32Array(h);
      const sampleStepX = Math.max(1, Math.floor(w / 900));
      const sampleStepY = Math.max(1, Math.floor(h / 9000));
      for (let y = 0; y < h; y += sampleStepY) {
        let dark = 0;
        for (let x = 0; x < w; x += sampleStepX) {
          const o = (y * w + x) * 4;
          const gray = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
          if (data[o + 3] > 16 && gray < 96) dark++;
        }
        const scaledDark = dark * sampleStepX;
        for (let yy = y; yy < Math.min(h, y + sampleStepY); yy++) rowDark[yy] = scaledDark;
      }

      const minQrSize = Math.max(96, Math.round(w * 0.35));
      const maxQrSize = Math.round(w * 1.4);
      const rowThreshold = Math.max(24, Math.round(w * 0.08));
      const bands = [];
      let inBand = false;
      let start = 0;
      let weakRows = 0;
      for (let y = 0; y < h; y++) {
        const strong = rowDark[y] >= rowThreshold;
        if (strong && !inBand) {
          inBand = true;
          start = y;
          weakRows = 0;
        } else if (!strong && inBand) {
          weakRows++;
          if (weakRows > Math.max(4, Math.round(minQrSize * 0.03))) {
            bands.push([start, y - weakRows]);
            inBand = false;
            weakRows = 0;
          }
        } else if (strong && inBand) {
          weakRows = 0;
        }
      }
      if (inBand) bands.push([start, h - 1]);

      const candidates = [];
      for (const [bandStart, bandEnd] of bands) {
        const bandHeight = bandEnd - bandStart + 1;
        if (bandHeight < minQrSize * 0.45 || bandHeight > maxQrSize * 1.8) continue;
        const colDark = new Uint32Array(w);
        const yStep = Math.max(1, Math.floor(bandHeight / 900));
        for (let y = bandStart; y <= bandEnd; y += yStep) {
          for (let x = 0; x < w; x += sampleStepX) {
            const o = (y * w + x) * 4;
            const gray = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
            if (data[o + 3] > 16 && gray < 96) {
              for (let xx = x; xx < Math.min(w, x + sampleStepX); xx++) colDark[xx]++;
            }
          }
        }
        const colThreshold = Math.max(3, Math.round((bandHeight / yStep) * 0.05));
        let left = -1;
        let right = -1;
        let runStart = -1;
        for (let x = 0; x < w; x++) {
          const strong = colDark[x] >= colThreshold;
          if (strong && runStart < 0) runStart = x;
          if ((!strong || x === w - 1) && runStart >= 0) {
            const runEnd = strong && x === w - 1 ? x : x - 1;
            if (runEnd - runStart > right - left) {
              left = runStart;
              right = runEnd;
            }
            runStart = -1;
          }
        }
        if (left < 0 || right <= left) continue;

        const width = right - left + 1;
        const size = Math.max(width, bandHeight);
        if (size < minQrSize || size > maxQrSize) continue;
        const pad = Math.max(8, Math.round(size * 0.04));
        const x = Math.max(0, left - pad);
        const y = Math.max(0, bandStart - pad);
        const cw = Math.min(w - x, width + pad * 2);
        const ch = Math.min(h - y, bandHeight + pad * 2);
        const aspect = cw / ch;
        if (aspect < 0.55 || aspect > 1.8) continue;
        candidates.push({ x, y, w: cw, h: ch, score: Math.min(cw, ch) });
      }

      candidates.sort((a, b) => a.y - b.y || b.score - a.score);
      const deduped = [];
      for (const c of candidates) {
        const duplicate = deduped.some((d) => {
          const ix = Math.max(0, Math.min(c.x + c.w, d.x + d.w) - Math.max(c.x, d.x));
          const iy = Math.max(0, Math.min(c.y + c.h, d.y + d.h) - Math.max(c.y, d.y));
          const intersection = ix * iy;
          const smaller = Math.min(c.w * c.h, d.w * d.h);
          return smaller > 0 && intersection / smaller > 0.55;
        });
        if (!duplicate) deduped.push(c);
      }
      return deduped.slice(0, 128);
    };
    const scanDetectedQrRegions = async () => {
      report("正在检测二维码区域");
      const regions = await detectQrCandidateRegions();
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        decodeRegion(r.x, r.y, r.w, r.h, r.y);
        scanCount++;
        if (completeGroupKey) return true;
        if (scanCount % 4 === 0) {
          report("正在解码候选二维码区域");
          await yieldFrame();
          if (timeExceeded()) return false;
        }
      }
      return completeGroupKey != null;
    };

    report("正在识别整图");
    decodeSquare(0, 0, Math.min(w, h));
    if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);

    if (!completeGroupKey && !timeExceeded()) {
      const detectedDone = await scanDetectedQrRegions();
      if (detectedDone && completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
    }

    report("正在定位首个分片");
    let firstQrY = -1;
    let scanY = 0;
    while (firstQrY < 0 && scanY + scaledPadding + scaledQrSize <= h) {
      const qrTop = scanY + scaledPadding;
      tryDecodeAtTop(qrTop);
      scanCount++;
      if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
      const best = bestGroupInfo();
      if (best && best.group.indices.size > 0) firstQrY = qrTop;
      if (scanCount % 10 === 0) {
        report("正在定位首个分片");
        await yieldFrame();
      }
      if (timeExceeded()) break;
      if (firstQrY < 0) scanY += scaledPadding;
    }

    if (firstQrY < 0 && !timeExceeded()) {
      const step = Math.max(24, Math.round(scaledPadding * 1.5));
      for (let y = 0; y + cropWidth <= h; y += step) {
        tryDecodeAtTop(y);
        scanCount++;
        if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
        const best = bestGroupInfo();
        if (best && best.group.indices.size > 0) {
          firstQrY = y;
          break;
        }
        if (scanCount % 10 === 0) {
          report("正在扫描长图");
          await yieldFrame();
        }
        if (timeExceeded()) break;
      }
    }

    if (firstQrY >= 0 && !timeExceeded()) {
      report("正在按分页补齐分片");
      const tolerance = Math.max(16, Math.round(50 * scale));
      const toleranceStep = Math.max(4, Math.floor(scaledPadding / 2));
      let page = 1;
      while (!timeExceeded()) {
        const expectedY = firstQrY + page * pageHeight;
        if (expectedY - tolerance >= h) break;
        for (let off = -tolerance; off <= tolerance; off += toleranceStep) {
          tryDecodeAtTop(expectedY + off);
          scanCount++;
          if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
          if (scanCount % 10 === 0) {
            report("正在按分页补齐分片");
            await yieldFrame();
          }
          if (timeExceeded()) break;
        }
        page += 1;
        if (page > 24) break;
      }
    }

    if (!completeGroupKey && !timeExceeded()) {
      report("正在执行兼容补扫");
      const pages = Math.max(1, Math.ceil(h / pageHeight));
      for (let i = 0; i < pages; i++) {
        tryDecodeAtTop(i * pageHeight + scaledPadding);
        scanCount++;
        if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
        if (scanCount % 10 === 0) {
          report("正在执行兼容补扫");
          await yieldFrame();
        }
        if (timeExceeded()) break;
      }
    }

    if (!completeGroupKey && !timeExceeded()) {
      report("正在按 App 长图格式补扫");
      const appDone = await scanLongImageLayout(APP_LONG_IMAGE, "正在按 App 长图格式补扫");
      if (appDone && completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
    }

    if (!completeGroupKey && !timeExceeded()) {
      report("正在执行全局相位补扫");
      const pages = Math.max(1, Math.ceil(h / pageHeight) + 1);
      const phaseStep = Math.max(6, Math.floor(scaledPadding / 2));
      const xOffsets = [0, Math.round(cropWidth * 0.01), -Math.round(cropWidth * 0.01)];
      const sizeJitter = [1, 0.985, 1.01];
      for (let phase = 0; phase < pageHeight; phase += phaseStep) {
        for (let i = 0; i < pages; i++) {
          const y = phase + scaledPadding + i * pageHeight;
          if (y >= h) break;
          for (const xo of xOffsets) {
            for (const mul of sizeJitter) {
              const s = Math.max(24, Math.round(cropWidth * mul));
              const x = safeLeft + xo;
              decodeSquare(x, y, s);
              scanCount++;
              if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
              if (scanCount % 10 === 0) {
                await yieldFrame();
                if (timeExceeded()) break;
              }
            }
            if (timeExceeded() || completeGroupKey) break;
          }
          if (timeExceeded() || completeGroupKey) break;
        }
        if (timeExceeded() || completeGroupKey) break;
      }
    }

    if (!completeGroupKey && !timeExceeded()) {
      const best = bestGroupInfo();
      if (best && best.group.total > 1 && best.group.total <= 16) {
        report("正在执行缺失分片精确补扫");
        const previewHeight = Math.max(0, h - best.group.total * pageHeight);
        const yBase = previewHeight + scaledPadding;
        const yOffsets = [0, Math.round(scaledPadding * 0.5), -Math.round(scaledPadding * 0.5), scaledPadding, -scaledPadding];
        const xOffsets = [0, Math.round(scaledPadding * 0.3), -Math.round(scaledPadding * 0.3), Math.round(scaledPadding * 0.7), -Math.round(scaledPadding * 0.7)];
        const missing = [];
        for (let idx = 1; idx <= best.group.total; idx++) {
          if (!best.group.indices.has(idx)) missing.push(idx);
        }

        let fittedFirstIndex = null;
        let fittedFirstY = null;
        let fittedStep = null;
        const posEntries = Array.from(best.group.positions.entries()).sort((a, b) => a[0] - b[0]);
        if (posEntries.length >= 2) {
          const first = posEntries[0];
          const last = posEntries[posEntries.length - 1];
          const deltaIndex = last[0] - first[0];
          if (deltaIndex > 0) {
            fittedFirstIndex = first[0];
            fittedFirstY = first[1];
            fittedStep = (last[1] - first[1]) / deltaIndex;
          }
        }

        for (const idx of missing) {
          const expectedY = (fittedStep != null && fittedFirstIndex != null && fittedFirstY != null)
            ? Math.round(fittedFirstY + (idx - fittedFirstIndex) * fittedStep)
            : (yBase + (idx - 1) * pageHeight);
          for (const yo of yOffsets) {
            for (const xo of xOffsets) {
              tryDecodeAtTopRobust(expectedY + yo, xo);
              scanCount++;
              if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
              if (scanCount % 8 === 0) {
                await yieldFrame();
                if (timeExceeded()) break;
              }
            }
            if (timeExceeded() || completeGroupKey) break;
          }
          if (timeExceeded() || completeGroupKey) break;
        }
      }
    }

    if (!completeGroupKey && !timeExceeded() && barcodeDetector) {
      report("正在执行原生多码补扫");
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = w;
      pageCanvas.height = Math.min(h, Math.max(64, Math.round(pageHeight)));
      const pctx = pageCanvas.getContext("2d", { willReadFrequently: true });
      const pages = Math.max(1, Math.ceil(h / pageHeight) + 1);
      for (let i = 0; i < pages; i++) {
        const y = Math.max(0, Math.round(i * pageHeight));
        const sh = Math.min(pageCanvas.height, h - y);
        if (sh <= 24) break;
        if (pageCanvas.height !== sh) pageCanvas.height = sh;
        pctx.clearRect(0, 0, pageCanvas.width, pageCanvas.height);
        pctx.drawImage(canvas, 0, y, w, sh, 0, 0, w, sh);
        await tryDetectByBarcodeDetector(pageCanvas, y);
        if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
        if (i % 2 === 1) {
          await yieldFrame();
          if (timeExceeded()) break;
        }
      }
      if (!completeGroupKey) {
        await tryDetectByBarcodeDetector(canvas, 0);
        if (completeGroupKey) return Array.from(byGroup.get(completeGroupKey).texts);
      }
    }

    const best = bestGroupInfo();
    return best ? Array.from(best.group.texts) : [];
  }

  function readFileAsImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("图片读取失败"));
      };
      img.src = url;
    });
  }

  window.WebEditorQrImport = {
    readFileAsImage,
    decodeQrTextFromImage
  };
})();
