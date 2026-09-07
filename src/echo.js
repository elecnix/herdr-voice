import { SAMPLE_RATE } from './config.js'

/**
 * Reference-based echo guard: decides whether the microphone is hearing the
 * USER or the agent's own voice coming back out of the speakers.
 *
 * WHY THIS EXISTS. Barge-in used to be a bare level threshold: mic RMS above
 * ~0.01 for 400 ms meant "the user is talking". That number is meaningless on
 * speakers, because the level the mic reports for the agent's own voice is
 * whatever the volume knob says it is. Turn the speakers up and the leak alone
 * clears the threshold for seconds at a time — the agent interrupts itself on
 * every sentence. The adaptive envelope that was bolted on could not fix it:
 * it has to attack slower than a barge takes to confirm (or it chases the
 * user's own voice and the barge never lands), so it is always behind, and it
 * decays back to ambient between turns — meaning every response starts with
 * the threshold at its most trigger-happy.
 *
 * THE FIX. We know exactly what we are playing. Keep the played PCM as a
 * REFERENCE envelope on the playback timeline, and judge the mic against what
 * the echo of that reference is PREDICTED to be, not against an absolute
 * level:
 *
 *   predicted(t) = hypot(gain x reference(t - delay), room noise)
 *   speech       = mic(t) > predicted(t) x margin
 *
 * `gain` is the room's speaker->mic coupling. It is a RATIO, so it tracks the
 * volume knob by construction: turning the speakers up multiplies both the
 * measured echo and the threshold, and the decision does not move. It is
 * learned continuously — fast up, slow down — and never from frames that
 * already look like speech, which is the trap the old envelope fell into.
 *
 * Two more properties make this work where a level threshold cannot:
 *  - Speech is detected in the reference's GAPS. Synthesized speech is full of
 *    them; there the prediction falls to the room's noise floor whatever the
 *    volume, so the user pokes through even when the echo is as loud as they
 *    are. Evidence is therefore counted over a sliding window rather than as a
 *    consecutive run — one frame back under the threshold must not throw away
 *    what has already been gathered.
 *  - A volume change is SHAPE-PRESERVING. Before a barge fires we re-fit a
 *    single gain over the decision window; if that one number explains every
 *    frame, the speakers just got louder — adopt it and keep talking. A second
 *    voice cannot be explained away, because it is uncorrelated with what we
 *    are playing and stands out wherever the agent is momentarily quiet.
 */

const FRAME_MS = 100
// The reference timeline is kept finer than the mic frames so the speaker->mic
// delay can be aligned to better than one frame: at 100ms resolution a 250ms
// path lands halfway between two frames and the predicted echo swings by a
// factor of three across a syllable — which reads as speech.
const SUB_MS = 25
const REF_KEEP_MS = 12_000 // reference timeline retention
const HISTORY_MS = 6_000 // mic frame retention

// Coupling-gain estimator.
//
// The threshold has to clear the LOUDEST echo frames, not the typical ones, so
// the estimate targets a high quantile of the observed coupling rather than its
// centre. Measured on real hardware: the coupling ran p50=0.20 but p90=0.39 and
// max=0.74, and an estimator sitting at 0.19 let one echo frame in ten over the
// line — four of those inside a second is a self-interruption.
//
// A second voice is excluded by REJECTing ratios far above the window's own
// centre, NOT by freezing the estimator while something looks like speech. That
// freeze was the earlier design and it is self-limiting: the gain can only ever
// learn from frames the current gain already explains, so it settles at the
// median and permanently mislabels everything above it. Rejection has no such
// loop — the median is robust to a voice in a minority of frames, and a voice in
// most frames of a four-second window is a barge, not a calibration.
const GAIN_WINDOW_MS = 4000
const GAIN_PERCENTILE = 0.9
const GAIN_MIN_FRAMES = 8
const GAIN_OUTLIER = 2.5 // ratios beyond this multiple of the centre are a voice
const GAIN_STEP_MS = 250
const GAIN_ATTACK = 0.6 // per step: a louder room is believed quickly
const GAIN_RELEASE = 0.15 // a quieter one is forgotten gradually
const GAIN_MIN = 0.005
const GAIN_MAX = 4

// Learn the gain only where the reference is genuinely loud — a ratio measured
// against near-silence is mostly room noise and would bias the estimate up.
const REF_ACTIVE_FRAC = 0.25
const REF_ACTIVE_MIN = 0.02

// How much of the previous frame's playback is still ringing in the room, as an
// amplitude fraction. Deliberately small: over-modelling the tail fills in the
// troughs between the agent's syllables, and those troughs are where a user
// quieter than the speakers is heard at all.
const REVERB_TAIL = 0.2
// How long past the end of the scheduled audio the speaker may still be heard.
// Bounded insurance for the boundary, where the schedule and the sound server
// disagree by whatever the alignment has not caught up with (a respawned player
// starts with a fresh buffer of its own). It costs sensitivity only in the
// moment right after the agent stops talking — never in the gaps between its
// words, which is where barge-in has to work.
const TAIL_HOLD_MS = 400

// Room noise floor (fans, someone typing). Measured as a low percentile of
// what the echo does not explain, over a few seconds — NOT as an envelope. An
// envelope can only learn from frames it has already judged to be quiet, so a
// room noisier than the starting guess flags every frame as speech and freezes
// its own floor at the wrong value; a percentile has no such deadlock, because
// a voice cannot lower the quiet end of a window, while steady noise raises all
// of it.
const AMBIENT_WINDOW_MS = 4000
const AMBIENT_PERCENTILE = 0.2
const AMBIENT_INIT = 0.003

// Calibration. The room is measured from the observed mic/reference ratio over
// a few seconds of playback; until that first measurement exists the guard does
// not fire while the agent is audible — about the first second of the first
// thing it ever says.
const CAL_WINDOW_MS = 4000
const CAL_MIN_FRAMES = 20
const CAL_PERCENTILE_ROUGH = 0.25

// Slack on the "can the mic hear the speakers at all" test, which runs on a
// coupling measured before alignment and therefore known only loosely.
const AUDIBILITY_MARGIN = 3
// Delay alignment. It cannot be a precondition for arming: with headphones —
// or any setup where the mic simply cannot hear the speakers — the mic is
// uncorrelated with the reference and no lag will ever correlate. That is not a
// failure, it is the answer (coupling ~ 0), and barge-in must work there.
// The alignment DRIFTS and must be re-fitted continuously, not once. The play
// head advances by a nominal 24000 samples per second; the sound card runs at
// its own rate, and the error accumulates — a few tenths of a percent is a third
// of a second over a minute-long answer. Measured on real hardware: mid-answer
// the mic's loud passages were arriving ~380ms after the reference said they
// should, so the guard expected echo where the room was quiet and heard the
// agent where it expected silence. Hence the generous ceiling (the accumulated
// offset, not just the acoustic path) and the frequent re-fit.
// Acquisition searches the plausible acoustic range once; after that the fit
// only TRACKS, searching close to where it already is. A speech envelope is
// quasi-periodic at the syllable rate, so a wide re-search can lock a syllable
// early or late and be perfectly happy about it — measured, as soon as the
// ceiling was raised to accommodate drift. Tracking cannot jump a syllable.
const MAX_DELAY_MS = 800
const TRACK_DELAY_MS = 150
const DELAY_CEILING_MS = 2000
const MIN_CORRELATION = 0.5
const DELAY_RETRY_MS = 2000
const DELAY_REFIT_MS = 2000

// How many frames may still stand out once the decision window has been
// re-fitted to a single, louder gain.
const EXPLAINED_OUTLIERS = 1
// A frame only counts against the volume-change explanation when it clears the
// refitted prediction by a clear factor — a wider bar than plain detection,
// because the question here is "is a SECOND voice present", not "is this loud".
const VETO_MARGIN = 2.4
const VETO_CORRELATION = 0.4
const VETO_DYNAMICS = 1.5
// How far either side of the fitted alignment the veto looks. Covers the frame
// or two the sound server wanders by; anything wider starts explaining real
// barges away by lining an edge up with an unrelated edge.
const VETO_LAG_SLACK = 100
// Evidence rises a frame at a time and leaks more slowly, so speech broken up by
// the agent's own syllables still confirms while an isolated noise does not. The
// leak rate is what decides how long someone has to keep talking: their voice
// only clears the bar in the agent's gaps, so with an equal leak the two nearly
// cancel out and it takes seconds of shouting to accumulate anything.
const EVIDENCE_LEAK = 0.25
const EVIDENCE_CAP = 8
// How much recent history the veto re-examines when a barge is proposed.
const DECISION_WINDOW = 2

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const excess = (level, noise) => Math.sqrt(Math.max(0, level * level - noise * noise))

export class EchoGuard {
  constructor({
    frameMs = FRAME_MS,
    floor = 0.01,
    margin = 1.45,
    bargeMs = 300,
    leak = EVIDENCE_LEAK,
    delayMs = 200,
    sampleRate = SAMPLE_RATE,
  } = {}) {
    this.frameMs = frameMs
    this.floor = floor
    this.margin = margin
    this.bargeMs = bargeMs
    this.leak = leak
    // Speaker -> air -> mic -> ffmpeg latency, fitted from the data during
    // calibration; this is only the starting guess.
    this.delayMs = delayMs
    this.subMs = SUB_MS
    this.subBytes = Math.floor((sampleRate * 2 * SUB_MS) / 1000)
    this.ref = [] // { t, rms } — when each played sub-frame is HEARD
    this.pending = Buffer.alloc(0) // partial sub-frame carried between chunks
    this.pendingAt = 0
    this.refPeak = 0
    this.history = [] // { t, m, r, speech }
    this.gain = 0
    this.measured = false // the room's coupling has been measured at least once
    this.delayFitted = false // the mic and the reference have been aligned
    this.alignTried = false // ...or alignment was attempted and found nothing
    this.alignMisses = 0
    this.pendingLag = null // an acquisition fit awaiting confirmation
    this.ambient = AMBIENT_INIT
    this.lastLearn = 0
    this.evidence = 0
    this.now = 0 // the guard's clock: the newest mic frame it has seen
    this.measuredAt = 0
    this.delayFitAt = 0
    this.ambientAt = 0
  }

  /**
   * Audio handed to the speaker, with the wall-clock time its first sample is
   * scheduled to be HEARD (the caller owns the playback schedule — the same one
   * that drives the echo gate). Only audio actually played may be pushed.
   */
  pushReference(pcm, startAt) {
    // A schedule that goes BACKWARDS means playback was dropped and restarted —
    // a barge, a typed interruption, the model streaming a fresh answer over the
    // top. Whatever was queued beyond this point will never be heard, and
    // leaving it behind makes the timeline non-monotonic, which silently breaks
    // the binary search that reads it: the lookup lands in the wrong series and
    // reports near-silence for audio that is playing at full volume, so the
    // threshold collapses to the bare floor and the agent interrupts itself.
    // (Measured on a real session: the play head ran to 81s of queued audio,
    // was reset, and the next chunk landed at 25s — 56 seconds out of order.)
    // Repairing it here rather than trusting every caller to announce a flush.
    if (this.ref.length && startAt < this.ref[this.ref.length - 1].t + this.subMs) {
      this.dropScheduled(startAt)
    }
    const bytesPerMs = this.subBytes / this.subMs
    if (this.pending.length) {
      const expected = this.pendingAt + this.pending.length / bytesPerMs
      // Non-contiguous (a flush, or a fresh stream after silence): the carried
      // remainder belongs to audio that is no longer adjacent — drop it.
      if (Math.abs(startAt - expected) > this.subMs) this.pending = Buffer.alloc(0)
    }
    if (!this.pending.length) this.pendingAt = startAt
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm
    while (this.pending.length >= this.subBytes) {
      const rms = frameRms(this.pending.subarray(0, this.subBytes))
      this.pending = this.pending.subarray(this.subBytes)
      this.ref.push({ t: this.pendingAt, rms })
      this.pendingAt += this.subMs
      this.refPeak = Math.max(rms, this.refPeak * 0.999)
    }
    // Retention runs backwards from the guard's OWN clock — the newest mic
    // frame — and never from the timeline's newest entry. The model streams far
    // faster than realtime (fifteen seconds of answer can arrive in one), so the
    // newest entry sits well in the future; measuring retention from there
    // deletes the audio that is playing RIGHT NOW, leaving the guard with no
    // reference for what the mic is hearing and nothing to fall back on but the
    // bare floor — which is the very bug this class replaced.
    if (!this.now) return
    const cutoff = this.now - REF_KEEP_MS
    while (this.ref.length && this.ref[0].t < cutoff) this.ref.shift()
  }

  /** Playback was flushed: everything not yet heard will never be heard. */
  dropScheduled(now = this.now || Date.now()) {
    let n = this.ref.length
    while (n > 0 && this.ref[n - 1].t >= now) n--
    this.ref.length = n
    this.pending = Buffer.alloc(0)
  }

  /** Level the agent's own voice is arriving at right now. */
  echoLevel(now = this.now || Date.now()) {
    return this.gain * this._refFor(now)
  }

  /**
   * One mic frame (the level of the chunk ENDING at `now`). `armed` is false
   * when a barge is impossible anyway — muted, full duplex, nothing running.
   * The guard still measures the room on those frames; it just never fires.
   */
  observe({ level, now = Date.now(), armed = false }) {
    this.now = now
    const r = this._refFor(now)
    // The mic never reports less than the room's own noise, so the prediction
    // carries it too — the two are uncorrelated and add in power. Without it
    // the prediction collapses wherever the agent is quiet and ordinary room
    // noise reads as the user talking.
    const predicted = Math.hypot(this.gain * r, this.ambient)
    const threshold = Math.max(this.floor, predicted * this.margin)
    const speech = level >= threshold
    this.history.push({ t: now, m: level, r, speech })
    while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift()

    this._updateAmbient(now)
    this._measure(now)
    if (this.measured) this._learn(now)

    // Evidence accumulates and LEAKS, rather than being counted inside a fixed
    // window. It must not require consecutive frames — with loud speakers the
    // user only clears the prediction in the gaps between the agent's words, so
    // a consecutive run never builds — but a plain count over a wide window is
    // just as wrong in the other direction: two isolated clicks and two marginal
    // frames half a second later add up to a barge that nobody asked for
    // (measured, on a real session, as playback restarted). Leaking forgives the
    // gaps in someone's speech while letting a transient fade.
    // Nothing accumulates while a decision would not be trusted anyway — an
    // unmeasured room, a muted mic, nothing to interrupt. Otherwise the count
    // builds up unseen and fires the instant the guard arms.
    const listening = armed && this._ready(now)
    this.evidence = listening ? clamp(this.evidence + (speech ? 1 : -this.leak), 0, EVIDENCE_CAP) : 0
    const run = this.evidence
    let barge = run * this.frameMs >= this.bargeMs
    if (barge && this._explainedByReference(now)) barge = false
    return {
      barge, speech, run, level, threshold, predicted,
      ref: r, gain: this.gain, ambient: this.ambient, delayMs: this.delayMs,
    }
  }

  /**
   * Measure the room: the coupling from the observed ratio, and — when the mic
   * can actually hear the speakers — the delay that aligns them. Runs until the
   * first measurement lands, then keeps re-fitting the delay in the background.
   */
  _measure(now) {
    const due = this.delayFitted ? DELAY_REFIT_MS : DELAY_RETRY_MS
    if (now - this.measuredAt < 500 && now - this.delayFitAt < due) return
    const win = this.history.filter((f) => now - f.t <= CAL_WINDOW_MS)

    // The coupling comes first, and needs under a second of playback. Aligning
    // needs seconds of history — and the guard must not stay disarmed for the
    // longer of the two, or a user who talks over the agent's first sentence
    // goes unheard. The first measurement also answers whether there is any
    // echo to align at all.
    if (now - this.measuredAt >= 500) {
      this.measuredAt = now
      if (!this.measured) this._seedFrom(win, { rough: true })
    }

    // Aligning a reference the mic cannot hear is meaningless: nothing
    // correlates, any "fit" is a coincidence, and re-seeding on one would
    // measure whatever the user happened to be saying instead.
    if (!this.echoAudible || win.length < CAL_MIN_FRAMES || now - this.delayFitAt < due) return
    this.delayFitAt = now
    // Re-fits ignore frames already judged to be speech; the first fit has no
    // trustworthy judgements to go on and uses everything.
    const src = this.delayFitted ? win.filter((f) => !f.speech) : win
    const fit =
      src.length < CAL_MIN_FRAMES
        ? null
        : this.delayFitted
          ? this._bestLag(src, this.delayMs - TRACK_DELAY_MS, Math.min(DELAY_CEILING_MS, this.delayMs + TRACK_DELAY_MS))
          : this._bestLag(src)
    if (!fit) {
      // Two windows in a row with nothing correlating: the mic is not hearing
      // the speakers. One is not enough — a user talking through the whole
      // first window would fail the fit too, and arming on a coupling measured
      // through their voice is how false barges start.
      this.alignMisses++
      if (this.alignMisses >= 2) this.alignTried = true
      return
    }
    this.alignMisses = 0
    if (this.delayFitted) {
      this.delayMs = fit.lag
      return
    }
    // The FIRST alignment has to be confirmed by a second, independent window
    // before anything is staked on it. Fitted on the two seconds of history that
    // are the minimum to fit at all, it can land a syllable out and look fine —
    // and the guard arms the moment it believes it is aligned. (Measured: an
    // acquisition fit jumped to 425ms, the reference then read near-silence
    // exactly where the mic was hearing the agent, and it interrupted itself
    // five seconds into the session.)
    if (this.pendingLag === null || Math.abs(fit.lag - this.pendingLag) > this.frameMs) {
      this.pendingLag = fit.lag
      return
    }
    this.delayMs = fit.lag
    this.delayFitted = true
    // The alignment invalidates everything measured against the old guess — the
    // coupling and the speech flags alike.
    if (this._seedFrom(win)) {
      for (const f of this.history) f.speech = false
    }
  }

  /**
   * Robust upper envelope of the coupling observed over `win`: a high quantile
   * of mic/reference, after discarding ratios far above the window's own
   * centre. Those outliers are a second voice — uncorrelated with the
   * reference, so it dominates the ratio wherever the agent is momentarily
   * quiet — while genuine echo, however loud the speakers, keeps every frame in
   * proportion. Returns null when the window holds too little playback to say
   * anything.
   */
  _coupling(win, { percentile = GAIN_PERCENTILE, reject = true } = {}) {
    const active = Math.max(REF_ACTIVE_MIN, this.refPeak * REF_ACTIVE_FRAC)
    const ratios = []
    for (const f of win) {
      const r = this._refFor(f.t)
      if (r >= active) ratios.push(excess(f.m, this.ambient) / r)
    }
    if (ratios.length < GAIN_MIN_FRAMES) return null
    ratios.sort((a, b) => a - b)
    let kept = ratios
    if (reject) {
      // Anchored on whichever is larger, so an estimate that has drifted LOW can
      // still climb out: tied to the gain alone, every honest frame would be
      // rejected as an outlier and the estimate would freeze at its own mistake
      // — the same trap the adaptation freeze fell into.
      const cap = GAIN_OUTLIER * Math.max(ratios[ratios.length >> 1], this.gain)
      kept = ratios.filter((x) => x <= cap)
      if (kept.length < GAIN_MIN_FRAMES) return null
    }
    return kept[Math.floor(percentile * (kept.length - 1))]
  }

  /**
   * First measurement of the room. The two callers ask different questions and
   * take different answers.
   *
   * BEFORE alignment (`rough`) the only question is "can the mic hear the
   * speakers at all", and the window may be mostly the user talking over the
   * agent's first sentence — so take a LOW quantile with nothing rejected.
   * Seeding high there once measured a "coupling" of 3.4 off the user's own
   * voice and went deaf for seconds.
   *
   * AFTER alignment the window is echo-dominated by construction — a window the
   * user talked through would not have correlated with the reference in the
   * first place — so take the same upper quantile the running estimator uses,
   * and take it outright rather than easing toward it: the guard arms the
   * moment it is aligned, and must not spend that first second below the mark.
   */
  _seedFrom(win, { rough = false } = {}) {
    const g = rough
      ? this._coupling(win, { percentile: CAL_PERCENTILE_ROUGH, reject: false })
      : this._coupling(win)
    if (g === null) return false
    this.gain = clamp(g, GAIN_MIN, GAIN_MAX)
    this.measured = true
    this.lastLearn = win[win.length - 1].t
    return true
  }

  /**
   * Track the coupling. Fast up, slower down: under-estimating makes the agent
   * interrupt itself, over-estimating only costs a little sensitivity.
   *
   * The estimate may only RISE while the mic is following the reference. A
   * louder room moves the two together; a second voice moves only the mic.
   * Without that condition the estimator learns the coupling from whoever is
   * talking — measured, it took a user's voice for a coupling of 3.7 and went
   * deaf for the rest of the sentence. Falling is always allowed: an estimate
   * that is too high can never cause the failure this class exists to prevent,
   * so it needs no permission to come back down.
   */
  _learn(now) {
    if (now - this.lastLearn < GAIN_STEP_MS) return
    const win = this.history.filter((f) => now - f.t <= GAIN_WINDOW_MS)
    const target = this._coupling(win)
    if (target === null) return
    this.lastLearn = now
    // Two conditions to raise the estimate, and both are about the same doubt:
    // is this louder room, or a second voice? The mic must be following the
    // reference, and nothing may currently look like speech. If the room really
    // is louder than the estimate says, the barge that follows will be handed to
    // _explainedByReference, which recognises it and corrects the gain outright
    // — so there is an escape hatch, and it does not run through here.
    if (target > this.gain && (this.evidence > 0 || !this._followsReference(win))) return
    const k = target > this.gain ? GAIN_ATTACK : GAIN_RELEASE
    this.gain = clamp(this.gain + (target - this.gain) * k, GAIN_MIN, GAIN_MAX)
  }

  /** Does the microphone rise and fall with what we are playing? */
  _followsReference(win) {
    const shape = pearson(
      win.map((f) => f.r),
      win.map((f) => f.m)
    )
    return shape !== null && shape >= VETO_CORRELATION
  }

  /**
   * Reference level for the mic frame ending at `now`. The frame integrates
   * 100 ms of sound, so the prediction integrates the same 100 ms of reference
   * — shifted by the delay — rather than sampling it at a point. Earlier frames
   * contribute a decaying tail for room reverb.
   */
  _refFor(now, delayMs = this.delayMs) {
    const end = now - delayMs
    let power = 0
    let w = 1
    for (let i = 0; i < 3; i++) {
      const p = this._refWindow(end - (i + 1) * this.frameMs, end - i * this.frameMs) * w
      power += p * p
      w *= REVERB_TAIL
    }
    return Math.max(Math.sqrt(power), this._tailHold(end))
  }

  /**
   * The schedule says when audio SHOULD be heard; the sound server decides when
   * it actually is. Any slack — pacat's own buffer, a backed-up pipe, a delay
   * fit that is a little short — lands at the END of a response, where the
   * reference stops while the speaker is still talking. The threshold then
   * collapses to the bare floor at the exact moment the leak is loudest, which
   * is a self-interruption. (Measured: ref fell 0.043 -> 0.001 while the mic was
   * still hearing 0.055.)
   *
   * So the end of the schedule is treated as uncertain: for a short hold after
   * it, keep predicting what the last of the audio was doing. It costs a little
   * sensitivity in the moment right after the agent stops — never in the gaps
   * between its words, which is where barge-in actually has to work.
   */
  _tailHold(end) {
    const a = this.ref
    if (!a.length) return 0
    const last = a[a.length - 1].t + this.subMs
    if (end < last || end > last + TAIL_HOLD_MS) return 0
    return this._refWindow(last - this.frameMs, last)
  }

  /** RMS of the scheduled playback over [from, to). Times with nothing
   *  scheduled count as silence, which is what the speaker actually emits. */
  _refWindow(from, to) {
    const a = this.ref
    const slots = Math.max(1, Math.round((to - from) / this.subMs))
    if (!a.length || to <= a[0].t || from >= a[a.length - 1].t + this.subMs) return 0
    let lo = 0
    let hi = a.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (a[mid].t < from) lo = mid + 1
      else hi = mid
    }
    let sum = 0
    for (let i = lo; i < a.length && a[i].t < to; i++) sum += a[i].rms * a[i].rms
    return Math.sqrt(sum / slots)
  }

  /**
   * Whether a decision can be trusted at all.
   *
   * Nothing playing: yes — there is no echo to be confused by, and the absolute
   * floor is the whole rule.
   * Playing but inaudible to the mic (headphones, or a speaker the mic cannot
   * reach): yes, as soon as the coupling has been measured as negligible. This
   * case must NOT wait for the reference and the mic to be aligned, because
   * nothing correlates when there is no echo — that alignment would never
   * arrive, and barge-in would be dead exactly where it is easiest.
   * Playing and audible: once aligned — an unaligned prediction mispredicts in
   * both directions across every syllable and the low side reads as speech — or
   * once alignment has been tried and repeatedly found nothing.
   */
  _ready(now) {
    if (this._quiet(now)) return true
    if (!this.measured) return false
    // Aligned, or there is nothing to align: either the coupling is too small
    // to matter, or a full window went by without any lag correlating, which
    // says the same thing — the mic is not hearing the speakers. What we do NOT
    // do is stay disarmed forever waiting for an alignment that cannot come.
    return this.delayFitted || !this.echoAudible || this.alignTried
  }

  /** Whether the agent's own voice could reach the barge floor at the mic at
   *  all. When it cannot — headphones, or a speaker pointed away — there is
   *  nothing to be confused by and the guard gets out of the way. The margin
   *  covers how loosely the coupling is known before alignment. */
  get echoAudible() {
    return this.gain * AUDIBILITY_MARGIN * this.refPeak >= this.floor
  }

  /** The room's own noise: the quiet end of what the echo cannot account for,
   *  over the last few seconds. */
  _updateAmbient(now) {
    if (now - this.ambientAt < 500) return
    this.ambientAt = now
    const win = this.history.filter((f) => now - f.t <= AMBIENT_WINDOW_MS)
    if (win.length < 10) return
    // Measure where the agent is quietest: those frames are closest to pure room
    // noise, and what the echo does not explain there IS the noise. Frames under
    // loud playback are useless for it — the prediction's own error swamps the
    // quantity being measured. Reading zero is a real answer, not a failure: it
    // says the echo model accounts for everything the mic hears, and the
    // absolute floor takes over from there.
    const quietest = [...win].sort((a, b) => a.r - b.r).slice(0, Math.max(6, win.length >> 2))
    const vals = quietest.map((f) => excess(f.m, this.gain * f.r)).sort((a, b) => a - b)
    this.ambient = vals[Math.floor(AMBIENT_PERCENTILE * (vals.length - 1))]
  }

  /** True when nothing has been playing for the last half second. */
  _quiet(now) {
    for (let i = this.history.length - 1; i >= 0 && now - this.history[i].t <= 500; i--) {
      if (this.history[i].r > 0) return false
    }
    return true
  }

  /**
   * Align the reference to the mic by correlating their envelopes. The
   * speaker->mic path runs 150-400 ms depending on the sound server's buffer,
   * and a misaligned reference smears the agent's gaps — which is exactly where
   * the user is heard.
   */
  _bestLag(win, from = 0, to = MAX_DELAY_MS) {
    let best = null
    for (let lag = Math.max(0, from); lag <= to; lag += this.subMs) {
      const xs = []
      const ys = []
      for (const f of win) {
        xs.push(this._refFor(f.t, lag))
        ys.push(f.m)
      }
      const c = pearson(xs, ys)
      if (c !== null && (best === null || c > best.c)) best = { c, lag }
    }
    return best && best.c > MIN_CORRELATION ? best : null
  }

  /**
   * Last question before interrupting: is this whole window just the agent's
   * own voice after all — louder than the coupling estimate says, or arriving at
   * a slightly different moment than the alignment says?
   *
   * A volume change is shape-preserving, so one re-fitted gain explains every
   * frame. A second voice cannot be explained that way: it is uncorrelated with
   * what we are playing and stands out wherever the agent is momentarily quiet.
   */
  _explainedByReference(now) {
    const win = this.history.filter((f) => now - f.t <= this.bargeMs * DECISION_WINDOW)
    if (win.length < 6) return false
    // The alignment is a best AVERAGE fit over seconds, and moment to moment the
    // sound server wanders around it — a speech envelope is quasi-periodic at
    // the syllable rate, so a fit can also settle a syllable early or late and
    // look entirely reasonable. Rather than smear the per-frame prediction to
    // cover that (which fills in the gaps the user is heard through, and
    // measurably costs real barges), ask the question ONCE, here, where it
    // matters: can the window be explained as the agent's own voice at any
    // alignment NEAR the fitted one? Only a candidate barge pays for the search.
    // The neighbourhood is deliberately narrow — searched widely, an arbitrary
    // shift will align some edge of the reference with some edge of the mic and
    // explain away a real barge (measured, on a step-shaped test signal).
    for (let d = -VETO_LAG_SLACK; d <= VETO_LAG_SLACK; d += this.frameMs) {
      const lag = this.delayMs + d
      if (lag >= 0 && this._explainedAt(win, lag)) return true
    }
    return false
  }

  /** Can the window be read as the reference at one gain, at this alignment? */
  _explainedAt(win, lag) {
    const at = new Map()
    for (const f of win) at.set(f, lag === this.delayMs ? f.r : this._refFor(f.t, lag))
    // The mic must be FOLLOWING the reference for "it is only louder" to mean
    // anything, and the reference must have something to follow: a featureless
    // one explains any steady level, a steady human voice included (measured —
    // a constant test tone let the veto swallow a real barge and adopt the
    // user's voice as the room's coupling).
    let lo = Infinity
    let hi = 0
    let sr2 = 0
    let smr = 0
    for (const f of win) {
      const r = at.get(f)
      lo = Math.min(lo, r)
      hi = Math.max(hi, r)
      sr2 += r * r
      smr += f.m * r
    }
    if (sr2 <= 0 || hi < lo * VETO_DYNAMICS) return false
    const shape = pearson(
      win.map((f) => at.get(f)),
      win.map((f) => f.m)
    )
    if (shape === null || shape < VETO_CORRELATION) return false
    const a = smr / sr2
    let outliers = 0
    for (const f of win) {
      if (f.m >= Math.max(this.floor, Math.hypot(a * at.get(f), this.ambient) * VETO_MARGIN)) outliers++
    }
    if (outliers > EXPLAINED_OUTLIERS) return false
    // Only adopt a gain measured at the alignment actually in use; a fit at some
    // other lag explains the window but says nothing about the room.
    if (lag === this.delayMs && a > this.gain) this.gain = clamp(a, GAIN_MIN, GAIN_MAX)
    for (const f of win) f.speech = false
    return true
  }
}

/** Root-mean-square level of a PCM16 mono frame, normalized to 0..1. */
export function frameRms(buffer) {
  let sum = 0
  const n = Math.floor(buffer.length / 2)
  if (!n) return 0
  for (let i = 0; i < n; i++) {
    const s = buffer.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / n) / 32768
}

function pearson(xs, ys) {
  const n = xs.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  return sxy / Math.sqrt(sxx * syy)
}
