/**
 * Schmaps voice input — Web Speech API wrapper.
 * Listens for a spoken Canadian address and returns the transcript.
 */

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

export function isVoiceSupported() {
  return SpeechRecognition !== null;
}

/**
 * Listen for a single utterance.
 * @param {{ onStart?: () => void, onEnd?: () => void }} hooks
 * @returns {Promise<string>} the recognized transcript
 */
export function listenOnce(hooks = {}) {
  return new Promise((resolve, reject) => {
    if (!SpeechRecognition) {
      reject(new Error('Speech recognition is not supported in this browser.'));
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = 'en-CA';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    let settled = false;

    rec.onstart = () => hooks.onStart && hooks.onStart();

    rec.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (!transcript) {
        settled = true;
        reject(new Error('I didn’t catch that — please try again.'));
        return;
      }
      settled = true;
      resolve(transcript);
    };

    rec.onerror = (event) => {
      if (settled) return;
      settled = true;
      const map = {
        'not-allowed': 'Microphone access was denied. Check your browser permissions.',
        'service-not-allowed': 'Speech service is not allowed here.',
        'no-speech': 'I didn’t hear anything — tap the mic and speak your address.',
        network: 'Speech service needs a network connection.',
      };
      reject(new Error(map[event.error] || `Speech error: ${event.error}`));
    };

    rec.onend = () => {
      hooks.onEnd && hooks.onEnd();
      if (!settled) {
        settled = true;
        reject(new Error('Listening ended without a result.'));
      }
    };

    try {
      rec.start();
    } catch (err) {
      reject(err);
    }
  });
}

const MUTE_KEY = 'schmaps:muted';

/** Is voice guidance currently muted? (persisted) */
export function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the mute preference. */
export function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode — non-fatal */
  }
  if (muted && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/** Speak a short confirmation (used after routing completes). */
export function speak(text) {
  if (isMuted()) return;
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-CA';
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* non-fatal */
  }
}