// ---------------------------------------------------------------------------
//  Speaking an expense
//
//  "chai forty rupees" is faster than a keyboard with one hand holding a
//  cup. The Web Speech API is free and on-device on iOS; where it is absent
//  the button simply does not appear.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  SW.voiceAvailable = !!Recognition;

  // onResult({ description, amountPaise })
  SW.listen = function (onResult) {
    if (!Recognition) return SW.toast('This browser cannot listen', 'error');

    const rec = new Recognition();
    rec.lang = 'en-IN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    let settled = false;

    const overlay = document.createElement('div');
    overlay.className = 'listening';
    overlay.innerHTML =
      '<div class="listening-card">' +
        '<div class="listening-dot"></div>' +
        '<div class="listening-text">Listening…</div>' +
        '<div class="listening-hint">Try &ldquo;chai forty rupees&rdquo;</div>' +
        '<button type="button" class="btn-text" id="listen-stop">Stop</button>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      try { rec.stop(); } catch (e) { /* already stopped */ }
    }

    overlay.querySelector('#listen-stop').addEventListener('click', function () {
      settled = true;
      close();
    });

    rec.onresult = function (event) {
      settled = true;
      close();
      const said = (event.results && event.results[0] && event.results[0][0] &&
                    event.results[0][0].transcript) || '';
      if (!said.trim()) return SW.toast('Did not catch that');

      const amountPaise = SW.parseSpokenAmount(said);
      const description = SW.stripSpokenAmount(said);

      // Hand back what was heard as well, so the caller can show it — a
      // silent wrong guess is worse than an obvious one.
      onResult({ heard: said, description: description, amountPaise: amountPaise });
    };

    rec.onerror = function (e) {
      if (settled) return;
      settled = true;
      close();
      const why = {
        'not-allowed': 'Microphone access was refused.',
        'service-not-allowed': 'Microphone access was refused.',
        'no-speech': 'Did not hear anything.',
        'audio-capture': 'No microphone available.',
      };
      SW.toast(why[e.error] || 'Could not listen', 'error');
    };

    rec.onend = function () { if (!settled) close(); };

    try { rec.start(); } catch (e) { close(); SW.toast('Could not start listening', 'error'); }
  };
})();
