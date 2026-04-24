'use strict';

/**
 * AudioProtocol — Clinical autonomic reactivity protocol with guided breathing.
 *
 * Phases (index 0–7):
 *   0  Linha de Base              — silence (baseline measurement)
 *   1  Guia Respiratório 1        — alternating IN / OUT audio cues
 *   2  Silêncio pré-estressor      — silence (fixed 2 s)
 *   3  Estressor                  — stressor sound  (sirene.mp3) with fade
 *   4  Silêncio pós-estressor     — silence (fixed 2 s)
 *   5  Guia Respiratório 2        — alternating IN / OUT audio cues (recovery)
 *   6  Movimentação              — move.mp3 with fade
 *   7  Repouso                    — silence
 *
 * config object passed to start():
 *   bpm             {number}     — breaths per minute, 50/50 split assumed.
 *                                  halfPeriod = 30 000 / bpm  (ms)
 *   phaseDurations  {number[8]}  — duration of each phase in seconds.
 *                                  Indices 2 and 4 are fixed at 2 s.
 *                                  A value of 0 skips that phase.
 *
 * Exposed as the global constant AudioProtocol (non-module script, shared scope).
 *
 * Public API:
 *   AudioProtocol.start(config)  — begin protocol (stops any running instance first)
 *   AudioProtocol.stop()         — halt immediately and silence all audio
 *   AudioProtocol.isRunning()    — returns boolean
 */

// eslint-disable-next-line no-unused-vars
const AudioProtocol = (() => {

  // ── Audio instances ───────────────────────────────────────────────────────────
  const audioIn        = new Audio('inspira.mp3');
  const audioOut       = new Audio('expira.mp3');
  const audioEstressor = new Audio('sirene.mp3');
  const audioMove      = new Audio('move.mp3');

  // Preload hints to minimise latency on first play
  audioIn.preload        = 'auto';
  audioOut.preload       = 'auto';
  audioEstressor.preload = 'auto';
  audioMove.preload      = 'auto';

  // ── Phase metadata ────────────────────────────────────────────────────────────
  const PHASE_NAMES = [
    'Linha de Base',
    'Guia Respiratório 1',
    'Silêncio',
    'Estressor',
    'Silêncio',
    'Guia Respiratório 2',
    'Movimentação',
    'Repouso',
  ];

  // ── Internal state ───────────────────────────────────────────────────────────────────
  let _running      = false;
  let _config       = null;
  let _currentPhase = -1;   // active phase index (0–7), or -1 when idle
  let _phaseTimer   = null; // setTimeout handle for phase → phase+1 transition
  let _breathTimer  = null; // setTimeout handle for next IN/OUT breath cue
  let _fadeTimer    = null; // setInterval handle for estressor fade-in / fade-out
  const FADE_DURATION_MS = 800; // fade length in ms
  const FADE_STEP_MS     = 20;  // interval tick

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /**
   * Unlock all Audio elements in the current user-gesture context.
   * Browsers block programmatic .play() unless the audio was first started
   * synchronously inside a user-interaction handler.  Calling play→pause here
   * marks each element as "user-approved" for all future programmatic calls.
   */
  function _unlockAudio() {
    [audioIn, audioOut, audioEstressor].forEach(a => {
      a.play()
        .then(() => { a.pause(); a.currentTime = 0; })
        .catch(() => { /* already unlocked or no media error */ });
    });
  }

  /** Silence all audio and cancel any pending breath-cue / fade timeout. */
  function _stopAllAudio() {
    clearTimeout(_breathTimer);
    _breathTimer = null;
    clearInterval(_fadeTimer);
    _fadeTimer = null;
    [audioIn, audioOut, audioEstressor, audioMove].forEach(a => {
      try {
        a.pause();
        a.currentTime = 0;
        a.volume = 1;
      } catch (_) { /* ignore if media not yet loaded */ }
    });
  }

  /**
   * Recursive breath-cue scheduler (active only during guide phases 1 & 5).
   * Plays the requested cue immediately, then schedules the opposite one.
   *
   * @param {'in'|'out'} which        — cue to play right now
   * @param {number}     halfPeriodMs — ms per half-cycle (= 30 000 / bpm)
   */
  function _playBreath(which, halfPeriodMs) {
    // Guard: stop chain if the protocol was halted or we left a guide phase
    if (!_running || (_currentPhase !== 1 && _currentPhase !== 5)) return;

    // Stop the opposing cue before starting the new one
    const prev = which === 'in' ? audioOut : audioIn;
    prev.pause();
    prev.currentTime = 0;

    const audio = which === 'in' ? audioIn : audioOut;
    audio.currentTime = 0;
    audio.play().catch(err => console.warn('[AudioProtocol] play() bloqueado:', err.name, err.message));

    _breathTimer = setTimeout(() => {
      _playBreath(which === 'in' ? 'out' : 'in', halfPeriodMs);
    }, halfPeriodMs);
  }

  /**
   * Activate a protocol phase: start its audio behaviour and schedule the
   * transition to the next phase.  Phases ≥ PHASE_NAMES.length signal
   * protocol completion.
   *
   * @param {number} phaseIdx — 0-based index of the phase to enter
   */
  function _enterPhase(phaseIdx) {
    _stopAllAudio();
    clearTimeout(_phaseTimer);
    _phaseTimer = null;

    if (!_running || phaseIdx >= PHASE_NAMES.length) {
      _running      = false;
      _currentPhase = -1;
      _config?.onPhaseChange?.(-1, 0);
      console.info('[AudioProtocol] Protocolo concluído.');
      return;
    }

    _currentPhase = phaseIdx;
    const phaseDurMs   = (_config.phaseDurations[phaseIdx] ?? 0) * 1000;
    const halfPeriodMs = Math.round(30_000 / Math.max(1, _config.bpm));

    console.info(
      `[AudioProtocol] → Fase ${phaseIdx + 1}: ${PHASE_NAMES[phaseIdx]}` +
      ` (${phaseDurMs / 1000} s)`
    );

    // Notify UI callback
    _config.onPhaseChange?.(phaseIdx, phaseDurMs);

    // ── Audio behaviour for this phase ──────────────────────────────────────────
    switch (phaseIdx) {
      case 1: // Guia Respiratório 1 — IN/OUT cycle
      case 5: // Guia Respiratório 2 — IN/OUT cycle
        _playBreath('in', halfPeriodMs);
        break;

      case 3: { // Estressor — fade in, play, fade out before phase ends
        const FADE = FADE_DURATION_MS;
        const STEP = FADE_STEP_MS;
        const steps = FADE / STEP;
        let tick = 0;
        audioEstressor.volume = 0;
        audioEstressor.currentTime = 0;
        audioEstressor.play().catch(err => console.warn('[AudioProtocol] estressor bloqueado:', err.name));
        // Fade-in
        clearInterval(_fadeTimer);
        _fadeTimer = setInterval(() => {
          tick++;
          audioEstressor.volume = Math.min(1, tick / steps);
          if (tick >= steps) {
            clearInterval(_fadeTimer);
            _fadeTimer = null;
            // Schedule fade-out to start FADE_DURATION_MS before phase ends
            const fadeOutDelay = Math.max(0, phaseDurMs - FADE * 2);
            _fadeTimer = setTimeout(() => {
              let outTick = 0;
              _fadeTimer = setInterval(() => {
                outTick++;
                audioEstressor.volume = Math.max(0, 1 - outTick / steps);
                if (outTick >= steps) {
                  clearInterval(_fadeTimer);
                  _fadeTimer = null;
                  audioEstressor.pause();
                }
              }, STEP);
            }, fadeOutDelay);
          }
        }, STEP);
        break;
      }

      case 6: { // Movimentação — move.mp3 with fade-in and fade-out
        const FADE = FADE_DURATION_MS;
        const STEP = FADE_STEP_MS;
        const steps = FADE / STEP;
        let tick = 0;
        audioMove.volume = 0;
        audioMove.currentTime = 0;
        audioMove.play().catch(err => console.warn('[AudioProtocol] move bloqueado:', err.name));
        clearInterval(_fadeTimer);
        _fadeTimer = setInterval(() => {
          tick++;
          audioMove.volume = Math.min(1, tick / steps);
          if (tick >= steps) {
            clearInterval(_fadeTimer);
            _fadeTimer = null;
            const fadeOutDelay = Math.max(0, phaseDurMs - FADE * 2);
            _fadeTimer = setTimeout(() => {
              let outTick = 0;
              _fadeTimer = setInterval(() => {
                outTick++;
                audioMove.volume = Math.max(0, 1 - outTick / steps);
                if (outTick >= steps) {
                  clearInterval(_fadeTimer);
                  _fadeTimer = null;
                  audioMove.pause();
                }
              }, STEP);
            }, fadeOutDelay);
          }
        }, STEP);
        break;
      }

      case 0: // Linha de Base       — silence
      case 2: // Silêncio pré-estressor — silence
      case 4: // Silêncio pós-estressor — silence
      case 7: // Repouso             — silence
      default:
        break;
    }

    // ── Schedule transition to next phase ───────────────────────────────────────
    if (phaseDurMs <= 0) {
      // Zero-duration: skip phase synchronously (tail-call, max 5 deep)
      _enterPhase(phaseIdx + 1);
    } else {
      _phaseTimer = setTimeout(() => _enterPhase(phaseIdx + 1), phaseDurMs);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Start the protocol.  Any currently running instance is stopped first.
   * @param {{ bpm: number, phaseDurations: number[] }} config
   */
  function start(config) {
    if (_running) stop();
    _config  = config;
    _running = true;
    // Must be called synchronously inside the user-gesture handler so the
    // browser grants playback permission for all future programmatic calls.
    _unlockAudio();
    console.info('[AudioProtocol] Iniciando protocolo:', config);
    _enterPhase(0);
  }

  /** Halt the protocol immediately and silence all audio. */
  function stop() {
    _running = false;
    clearTimeout(_phaseTimer);
    _phaseTimer   = null;
    _currentPhase = -1;
    _stopAllAudio();
    _config?.onPhaseChange?.(-1, 0);
    console.info('[AudioProtocol] Protocolo interrompido.');
  }

  /** Returns true while the protocol is active. */
  function isRunning() {
    return _running;
  }

  return { start, stop, isRunning };

})();
