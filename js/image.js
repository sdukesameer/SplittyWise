// ---------------------------------------------------------------------------
//  Preparing a picture for upload
//
//  Storage on the free tier is worth respecting, so every image is squeezed
//  under a hard byte cap before it leaves the device. A photo straight from
//  a phone camera is three to eight megabytes; the same picture at avatar
//  size is comfortably under a hundred kilobytes and looks identical at the
//  size it is actually displayed.
//
//  Compressed rather than refused: telling someone their photo is too big is
//  useless advice when every photo they own is too big.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const CAP_BYTES = 100 * 1024;

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file is not an image the browser can read.'));
      };
      img.src = url;
    });
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/jpeg', quality);
      else resolve(null);
    });
  }

  // opts: { maxBytes, maxDim, square }
  SW.prepareImage = async function (file, opts) {
    opts = opts || {};
    const maxBytes = opts.maxBytes || CAP_BYTES;
    let dim = opts.maxDim || 640;

    if (!/^image\//.test(file.type || '')) {
      throw new Error('Pick an image file.');
    }

    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize images.');

    // Two passes: drop quality first, and only then dimensions. Quality
    // costs far less visually than size at the scale these are shown.
    for (let attempt = 0; attempt < 4; attempt++) {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;

      if (opts.square) {
        // Centre-crop to a square, so an avatar is never squashed.
        const side = Math.min(w, h);
        canvas.width = canvas.height = Math.min(side, dim);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side,
                      0, 0, canvas.width, canvas.height);
      } else {
        const scale = Math.min(1, dim / Math.max(w, h));
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      const qualities = [0.82, 0.7, 0.58, 0.45, 0.34];
      for (let i = 0; i < qualities.length; i++) {
        const blob = await toBlob(canvas, qualities[i]);
        if (!blob) throw new Error('This browser cannot encode images.');
        if (blob.size <= maxBytes) return blob;
      }

      dim = Math.round(dim * 0.7);   // still too big: shrink and go again
    }

    throw new Error('Could not get that picture under ' +
      Math.round(maxBytes / 1024) + ' KB. Try a simpler image.');
  };

  SW.IMAGE_CAP_BYTES = CAP_BYTES;

  SW.readableSize = function (bytes) {
    return bytes >= 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
      : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  };
})();
