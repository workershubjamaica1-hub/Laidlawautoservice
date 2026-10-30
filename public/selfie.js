// selfie.js — the live face check for a sole person who offers services.
// It opens the camera (no choosing an old picture), asks for a look straight ahead and one random move,
// and hands back both shots with a signed challenge from the server. An admin then looks at them and decides.
//   const check = SelfieCheck.mount(document.getElementById('box'));
//   check.ready()   -> true once both photos are taken
//   check.data()    -> { selfie1, selfie2, challenge }  (to send with the application)
(function () {
  const WIDTH = 640;
  function shot(video) {
    const scale = Math.min(1, WIDTH / (video.videoWidth || WIDTH));
    const c = document.createElement('canvas');
    c.width = Math.round((video.videoWidth || WIDTH) * scale); c.height = Math.round((video.videoHeight || 480) * scale);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }
  // A tiny grey picture, used only to tell that the second shot is not the same frame as the first
  function tiny(canvas) {
    const t = document.createElement('canvas'); t.width = 24; t.height = 24;
    const g = t.getContext('2d'); g.drawImage(canvas, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data, out = [];
    for (let i = 0; i < d.length; i += 4) out.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return out;
  }
  const difference = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

  function mount(box) {
    box.classList.add('selfie');
    box.innerHTML =
      '<p class="hint">We need to see that a real person is behind this account. Use your phone or computer camera: you cannot choose a picture from your gallery. Two quick photos: one looking straight at the camera, then one with a small move we ask for.</p>' +
      '<div class="sf-stage" hidden><video playsinline muted autoplay></video><p class="sf-prompt" role="status"></p></div>' +
      '<div class="sf-shots" hidden></div>' +
      '<div class="sf-actions"><button type="button" class="btn ghost sf-open">Open the camera</button><button type="button" class="btn sf-snap" hidden>Take photo</button><button type="button" class="linkbtn sf-retake" hidden>Start again</button></div>' +
      '<p class="error sf-error" role="alert"></p>';
    const $ = s => box.querySelector(s);
    const video = $('video');
    let stream = null, token = '', prompts = [], step = 0, shots = [], canvases = [];
    const fail = m => { $('.sf-error').textContent = m || ''; };
    const stop = () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } };

    async function faceCount(canvas) {
      if (!('FaceDetector' in window)) return null;   // not every browser can; the admin still checks every photo
      try { return (await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }).detect(canvas)).length; } catch (_) { return null; }
    }
    function showPrompt() { $('.sf-prompt').textContent = 'Photo ' + (step + 1) + ' of 2: ' + prompts[step]; $('.sf-snap').textContent = 'Take photo ' + (step + 1); }

    async function open() {
      fail('');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail('This browser cannot open the camera. Open this page in Chrome or Safari on your phone.');
      try {
        const r = await fetch('/auth/identity-challenge'); const c = await r.json();
        if (!r.ok) throw new Error(c.error || 'Could not start the check.');
        token = c.token; prompts = c.prompts; step = 0; shots = []; canvases = [];
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
      } catch (e) { return fail(e && e.name === 'NotAllowedError' ? 'Allow the camera for this page, then try again.' : (e.message || 'Could not open the camera.')); }
      video.srcObject = stream;
      $('.sf-stage').hidden = false; $('.sf-shots').hidden = true; $('.sf-open').hidden = true; $('.sf-snap').hidden = false; $('.sf-retake').hidden = true;
      showPrompt();
    }
    async function snap() {
      fail('');
      if (!video.videoWidth) return fail('The camera is still starting. Wait a second and try again.');
      const c = shot(video), faces = await faceCount(c);
      if (faces !== null && faces !== 1) return fail(faces === 0 ? 'We cannot see your face. Move into the light and face the camera.' : 'Only you should be in the photo.');
      canvases[step] = c; shots[step] = c.toDataURL('image/jpeg', 0.82);
      if (step === 0) { step = 1; showPrompt(); return; }
      if (difference(tiny(canvases[0]), tiny(canvases[1])) < 2) { canvases = []; shots = []; step = 0; showPrompt(); return fail('The two photos look the same. Start again and follow the instruction for photo 2.'); }
      stop();
      $('.sf-stage').hidden = true; $('.sf-snap').hidden = true; $('.sf-retake').hidden = false;
      $('.sf-shots').hidden = false; $('.sf-shots').innerHTML = shots.map(s => '<img alt="Your photo" src="' + s + '">').join('');
      box.dispatchEvent(new CustomEvent('selfie-done'));
    }
    $('.sf-open').addEventListener('click', open);
    $('.sf-snap').addEventListener('click', snap);
    $('.sf-retake').addEventListener('click', () => { shots = []; canvases = []; $('.sf-retake').hidden = true; open(); });
    return {
      ready: () => shots.length === 2,
      data: () => ({ selfie1: shots[0], selfie2: shots[1], challenge: token }),
      reset: () => { stop(); shots = []; canvases = []; $('.sf-stage').hidden = true; $('.sf-shots').hidden = true; $('.sf-snap').hidden = true; $('.sf-retake').hidden = true; $('.sf-open').hidden = false; fail(''); },
      stop
    };
  }
  window.SelfieCheck = { mount };
})();
