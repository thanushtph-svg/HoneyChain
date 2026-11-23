// QR scanner for consumers: camera (native BarcodeDetector where available, jsQR otherwise),
// a photo upload fallback, and manual code entry. Only HoneyChain batch codes are accepted.
import { useEffect, useRef, useState } from 'react';

const CODE_RE = /HC-\d{4}-\d{6}/i;
/** Extract a batch code from a scanned QR payload (a /verify/<code> URL or the bare code). */
export function batchCodeFrom(text) {
  const m = CODE_RE.exec(String(text ?? ''));
  return m ? m[0].toUpperCase() : null;
}

// jsQR is only downloaded when the browser has no native BarcodeDetector (or for photo uploads)
let jsQRPromise = null;
async function decodeImageData(img) {
  jsQRPromise ??= import('jsqr').then((m) => m.default);
  const jsQR = await jsQRPromise;
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return r?.data ?? null;
}

export default function QrScanner({ onCode }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [state, setState] = useState('idle'); // idle | starting | scanning | error
  const [message, setMessage] = useState(null);
  const [manual, setManual] = useState('');

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState('idle');
  };
  useEffect(() => stop, []);

  const handle = (raw) => {
    const code = batchCodeFrom(raw);
    if (!code) { setMessage(`That QR code is not a HoneyChain batch code (${String(raw).slice(0, 60)}).`); return false; }
    stop();
    onCode(code);
    return true;
  };

  const start = async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setMessage('This browser cannot open the camera here (the camera needs HTTPS or localhost). Upload a photo of the QR code or type the batch code instead.');
      return;
    }
    setState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      setState('scanning');
      const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          if (v.readyState >= 2) {
            let raw = null;
            if (detector) {
              const found = await detector.detect(v);
              raw = found[0]?.rawValue ?? null;
            } else {
              const c = canvasRef.current;
              c.width = v.videoWidth; c.height = v.videoHeight;
              const ctx = c.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(v, 0, 0, c.width, c.height);
              raw = await decodeImageData(ctx.getImageData(0, 0, c.width, c.height));
            }
            if (raw && handle(raw)) return;
          }
        } catch { /* keep scanning */ }
        setTimeout(tick, 250);
      };
      tick();
    } catch (e) {
      stop();
      setState('error');
      setMessage(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access, or upload a photo / type the code.' : `Camera could not start: ${e.message}`);
    }
  };

  const fromFile = (file) => {
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      const c = canvasRef.current;
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const raw = await decodeImageData(ctx.getImageData(0, 0, c.width, c.height));
      URL.revokeObjectURL(img.src);
      if (!raw) setMessage('No QR code found in that photo. Try a sharper, closer photo, or type the batch code.');
      else handle(raw);
    };
    img.src = URL.createObjectURL(file);
  };

  return (
    <div className="scanner">
      <div className={`scanner-view ${state === 'scanning' ? 'on' : ''}`}>
        <video ref={videoRef} playsInline muted aria-label="Camera preview" />
        {state !== 'scanning' && <div className="scanner-placeholder">Point the camera at the QR code on the jar label</div>}
      </div>
      <canvas ref={canvasRef} hidden />
      <div className="btn-row" style={{ marginTop: 10 }}>
        {state === 'scanning'
          ? <button type="button" className="btn secondary" onClick={stop}>Stop camera</button>
          : <button type="button" className="btn" onClick={start} disabled={state === 'starting'}>{state === 'starting' ? 'Starting camera...' : 'Scan with camera'}</button>}
        <label className="btn secondary">
          Upload a photo
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => fromFile(e.target.files?.[0])} />
        </label>
      </div>
      {message && <div className="alert warn" role="status" style={{ marginTop: 10 }}>{message}</div>}
      <form className="btn-row" style={{ marginTop: 14 }} onSubmit={(e) => {
        e.preventDefault();
        const code = batchCodeFrom(manual);
        if (code) onCode(code); else setMessage('Enter a batch code like HC-2026-000001.');
      }}>
        <input className="search" aria-label="Batch code" placeholder="or type the batch code, e.g. HC-2026-000001" value={manual} onChange={(e) => setManual(e.target.value)} />
        <button className="btn secondary">Verify code</button>
      </form>
    </div>
  );
}
