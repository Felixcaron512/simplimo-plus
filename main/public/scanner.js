// Scanner caméra : BarcodeDetector natif si disponible (Chrome/Android), sinon ZXing (iOS Safari).
// Formats : QR, Code 128, Data Matrix, EAN-13, Code 39. Flash (torch) si la caméra le permet.
export function createScanner(video, onCode) {
  let stream, track, timer, torchOn = false, last = '', lastAt = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const native = 'BarcodeDetector' in window
    ? new BarcodeDetector({ formats: ['qr_code', 'code_128', 'data_matrix', 'ean_13', 'code_39'] }) : null;
  let zx;
  if (!native && window.ZXing) {
    const Z = window.ZXing, hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.CODE_39]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zx = new Z.MultiFormatReader(); zx.setHints(hints);
  }
  async function decode() {
    if (native) { const r = await native.detect(video); return r[0] && r[0].rawValue; }
    const s = Math.min(1, 800 / video.videoWidth);
    canvas.width = video.videoWidth * s; canvas.height = video.videoHeight * s;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const Z = window.ZXing;
    try { return zx.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); }
    catch { return null; }
  }
  async function loop() {
    if (!stream) return;
    if (video.readyState >= 2) {
      try {
        const v = await decode(), t = Date.now();
        if (v && (v !== last || t - lastAt > 2500)) { last = v; lastAt = t; onCode(v); }
      } catch { /* image sans code */ }
    }
    timer = setTimeout(loop, native ? 120 : 200);
  }
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      video.srcObject = stream; await video.play();
      track = stream.getVideoTracks()[0];
      loop();
    },
    torchSupported: () => !!(track && track.getCapabilities && track.getCapabilities().torch),
    async toggleTorch() {
      torchOn = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      return torchOn;
    },
    stop() { clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; },
  };
}
