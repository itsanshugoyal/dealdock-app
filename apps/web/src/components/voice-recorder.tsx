"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Headphones, Mic, RotateCcw, ShieldCheck, Square, Trash2, TriangleAlert } from "lucide-react";
import { VOICE_CLIP_LIMITS, consentStatement, type SpeakingVoiceDto } from "@dealdock/core";
import { errorMessage } from "../lib/snapshot";
import { appStore } from "../lib/use-demo";
import { recordingToWav, type EncodedTake } from "../lib/wav";
import { clockDuration } from "../lib/format";
import { VoiceNote } from "./kit";
import { Button } from "./ui/button";
import { Sheet } from "./ui/sheet";
import { toast } from "./ui/toast";
import { cx } from "./ui/cx";

/** The API's own limits (VOICE_CLIP_LIMITS, shared with POST /voice/speaking), so a bad take is caught before upload. */
const { takeMinMs, takeMaxMs, totalMinMs, totalMaxMs } = VOICE_CLIP_LIMITS;
const CLIPPING_LIMIT = 0.002;

const READS = [
  {
    title: "Read your consent",
    hint: "Read it as you'd normally speak. It records your consent and becomes part of your voice.",
  },
  {
    title: "Read a reply in English",
    hint: "Say it like a voice note to a brand you're excited about.",
    text: "Hey! Thanks so much for reaching out, this sounds really fun. Could you share the brief, the deliverables and your timeline? Once I have those, I'll send over my rates and we can lock in the dates. Talk soon!",
  },
  {
    title: "Read a reply in Hinglish",
    hint: "Relaxed, the way you'd answer a follower.",
    text: "Heyy! Haan, coaching abhi open hai. Twelve weeks ka program hai, har week ek check-in ke saath. Fees aur saari details is link mein hain. Koi bhi sawaal ho toh bilkul pooch lena, no stress. Let's do it!",
  },
] as const;

type Step = "intro" | 0 | 1 | 2 | "review";

function micError(failure: unknown): string {
  const name = failure instanceof DOMException ? failure.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.";
  if (name === "NotFoundError") return "No microphone found. Connect one and try again.";
  if (name === "NotReadableError") return "Another app is using the microphone. Close it and try again.";
  return "Couldn't start recording. Try again.";
}

/** One take at a time: MediaRecorder for the audio, an analyser for the level meter (written to a CSS variable, not React state). */
function useTakeRecorder(onTake: (take: EncodedTake) => void) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const live = useRef<{ stream?: MediaStream; recorder?: MediaRecorder; context?: AudioContext; raf?: number; timer?: number }>({});

  const release = useCallback(() => {
    const current = live.current;
    if (current.raf) cancelAnimationFrame(current.raf);
    if (current.timer) window.clearInterval(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
    meter.current?.style.setProperty("--level", "0");
    live.current = {};
  }, []);

  useEffect(() => () => {
    if (live.current.recorder?.state === "recording") live.current.recorder.onstop = null;
    release();
  }, [release]);

  const start = async () => {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't record audio. Use the latest Chrome or Safari.");
      return;
    }
    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const startedAt = performance.now();
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        release();
        setPhase("processing");
        recordingToWav(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }))
          .then((take) => {
            if (take.durationMs < takeMinMs) {
              URL.revokeObjectURL(take.url);
              setError(`That take was under ${takeMinMs / 1000} seconds. Read the whole text, then stop.`);
            } else if (take.durationMs > takeMaxMs) {
              URL.revokeObjectURL(take.url);
              setError(`That take ran over ${takeMaxMs / 1000} seconds. Read it a little quicker, then stop.`);
            } else onTake(take);
          })
          .catch(() => setError("Couldn't process that recording. Record it again."))
          .finally(() => setPhase("idle"));
      };

      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value - 128) / 128);
        meter.current?.style.setProperty("--level", Math.min(1, peak * 1.8).toFixed(3));
        live.current.raf = requestAnimationFrame(tick);
      };

      live.current = { stream, recorder, context };
      recorder.start(250);
      setElapsed(0);
      setPhase("recording");
      tick();
      live.current.timer = window.setInterval(() => {
        const ms = performance.now() - startedAt;
        setElapsed(ms);
        if (ms >= takeMaxMs && recorder.state === "recording") recorder.stop();
      }, 200);
    } catch (failure) {
      release();
      setPhase("idle");
      setError(micError(failure));
    }
  };

  const stop = () => {
    const recorder = live.current.recorder;
    if (recorder?.state === "recording") recorder.stop();
  };

  return { phase, elapsed, error, meter, start, stop };
}

/** Bar heights for the live meter; fixed per bar so it reads as a voice, not noise. */
const METER = [0.35, 0.6, 0.85, 0.5, 1, 0.7, 0.45, 0.9, 0.6, 0.8, 0.4, 0.95, 0.55, 0.75, 0.5, 0.85, 0.65, 0.4, 0.7, 0.9, 0.5, 0.6, 0.35, 0.55];

function TakeStep({ index, statement, take, onTake, onClear }: {
  index: 0 | 1 | 2;
  statement: string;
  take: EncodedTake | null;
  onTake: (take: EncodedTake) => void;
  onClear: () => void;
}) {
  const read = READS[index];
  const text = index === 0 ? statement : READS[index].text;
  const recorder = useTakeRecorder(onTake);
  const recording = recorder.phase === "recording";
  const busy = recorder.phase === "starting" || recorder.phase === "processing";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-2">{read.hint}</p>
      <blockquote className="rounded-[20px] bg-inset px-5 py-4 text-[19px] font-medium leading-8 tracking-[-0.01em] text-ink">
        {text}
      </blockquote>

      {take && !recording ? (
        <div className="flex flex-col gap-3">
          <VoiceNote id={`take-${index}-${take.durationMs}`} url={take.url} durationMs={take.durationMs} tone="out" className="self-start" />
          <p className="flex items-center gap-1.5 text-caption font-semibold text-recovered"><Check aria-hidden size={15} />Recorded · {clockDuration(take.durationMs)}</p>
          {take.clipping > CLIPPING_LIMIT && (
            <p className="flex items-start gap-1.5 text-caption text-waiting"><TriangleAlert aria-hidden size={15} className="mt-px shrink-0" />Parts of this take are too loud. Move a little further from the mic and record it again for a cleaner voice.</p>
          )}
          <Button variant="secondary" size="sm" icon={RotateCcw} className="self-start" onClick={() => { onClear(); void recorder.start(); }}>Record again</Button>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => (recording ? recorder.stop() : void recorder.start())}
            disabled={busy}
            aria-label={recording ? "Stop recording" : "Start recording"}
            className={cx(
              "dd-press relative flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full text-white shadow-raised transition-colors disabled:opacity-60",
              recording ? "bg-danger" : "bg-brand",
            )}
          >
            {recording && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-danger/30 motion-reduce:animate-none" />}
            {recording ? <Square aria-hidden size={24} fill="currentColor" /> : <Mic aria-hidden size={28} />}
          </button>
          <div className="min-w-0 flex-1">
            <div ref={recorder.meter} aria-hidden className="flex h-10 items-center gap-[3px]" style={{ ["--level" as string]: 0 }}>
              {METER.map((height, bar) => (
                <span
                  key={bar}
                  className={cx("w-[4px] rounded-full transition-[height] duration-75", recording ? "bg-danger" : "bg-fill")}
                  style={{ height: `calc(12% + var(--level) * ${Math.round(height * 88)}%)` }}
                />
              ))}
            </div>
            <p className="mt-1 text-caption text-ink-3" aria-live="polite">
              {recorder.phase === "starting" ? "Starting the microphone…"
                : recorder.phase === "processing" ? "Saving your take…"
                : recording ? <span className="font-semibold text-danger tabular-nums">Recording · {clockDuration(recorder.elapsed)}</span>
                : "Tap the mic, read the text, then tap stop."}
            </p>
          </div>
        </div>
      )}
      {recorder.error && <p role="alert" className="flex items-start gap-1.5 text-caption text-danger"><TriangleAlert aria-hidden size={15} className="mt-px shrink-0" />{recorder.error}</p>}
    </div>
  );
}

/**
 * Speaking voice setup: three in-app reads (consent, English, Hinglish) sent
 * as WAV. Only the creator records their own voice; nothing here sends.
 */
export function VoiceRecorderSheet({ open, onClose, handle, igAccountId, onCreated }: {
  open: boolean;
  onClose: () => void;
  handle: string;
  igAccountId: string;
  onCreated?: (voice: SpeakingVoiceDto) => void;
}) {
  const [step, setStep] = useState<Step>("intro");
  const [takes, setTakes] = useState<Array<EncodedTake | null>>([null, null, null]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statement = useMemo(() => consentStatement(handle), [handle]);
  // Each slot's playback URL, so a take's audio is released as soon as it is replaced or the sheet closes.
  const slotUrls = useRef<Array<string | null>>([null, null, null]);
  const isOpen = useRef(open);
  isOpen.current = open;
  const releaseTakes = useCallback(() => {
    slotUrls.current.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    slotUrls.current = [null, null, null];
  }, []);

  useEffect(() => releaseTakes, [releaseTakes]);
  useEffect(() => {
    if (open) return;
    releaseTakes();
    setStep("intro");
    setTakes([null, null, null]);
    setError(null);
  }, [open, releaseTakes]);

  const setTake = (index: number, take: EncodedTake | null) => {
    // A take that finishes processing after the sheet closed is dropped, not kept for next time.
    if (take && !isOpen.current) { URL.revokeObjectURL(take.url); return; }
    const previous = slotUrls.current[index];
    if (previous && previous !== take?.url) URL.revokeObjectURL(previous);
    slotUrls.current[index] = take?.url ?? null;
    setTakes((list) => list.map((item, position) => (position === index ? take : item)));
  };
  const total = takes.reduce((sum, take) => sum + (take?.durationMs ?? 0), 0);
  const recorded = takes.filter(Boolean).length;
  const tooShort = total < totalMinMs;
  const tooLong = total > totalMaxMs;

  const submit = async () => {
    const [consent, english, hinglish] = takes;
    if (!consent || !english || !hinglish) return;
    setSubmitting(true);
    setError(null);
    try {
      const clip = (take: EncodedTake) => ({ base64: take.base64, mimeType: take.mimeType, durationMs: take.durationMs });
      const voice = await appStore.createSpeakingVoice({ igAccountId, consentStatement: statement, consentClip: clip(consent), samples: [clip(english), clip(hinglish)] });
      toast("Creating your speaking voice. It's usually ready in a minute.", { tone: "success" });
      onCreated?.(voice);
      releaseTakes();
      setTakes([null, null, null]);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "Couldn't create your voice. Try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const index = typeof step === "number" ? step : null;
  const title = step === "intro" ? "Record your speaking voice" : step === "review" ? "Check your takes" : READS[step].title;
  const back = () => setStep(step === "review" ? 2 : step === 0 ? "intro" : ((step as number) - 1) as Step);

  const footer = step === "intro" ? (
    <Button variant="money" size="lg" fullWidth icon={Mic} onClick={() => setStep(0)}>Start</Button>
  ) : step === "review" ? (
    <>
      <Button variant="ghost" onClick={back} disabled={submitting}>Back</Button>
      <Button variant="money" onClick={() => void submit()} loading={submitting} loadingLabel="Uploading…" disabled={tooShort || tooLong || recorded < 3}>Create my voice</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={back}>Back</Button>
      <Button variant="primary" onClick={() => setStep(index === 2 ? "review" : ((index! + 1) as Step))} disabled={!takes[index!]}>{index === 2 ? "Review" : "Next"}</Button>
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} title={title} dirty={recorded > 0 && !submitting} footer={footer} initialFocus="title">
      {index !== null && (
        <div className="mb-4 flex items-center gap-3">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[0, 1, 2].map((bar) => <span key={bar} className={cx("h-1 flex-1 rounded-full", takes[bar] ? "bg-brand" : bar === index ? "bg-ink" : "bg-fill")} />)}
          </div>
          <span className="text-caption font-semibold text-ink-3 tabular-nums">Take {index + 1} of 3</span>
        </div>
      )}

      {step === "intro" && (
        <div className="flex flex-col gap-4">
          <p className="text-body text-ink-2">Three short reads, about a minute in total. DealDock uses them to turn replies you approve into voice notes that sound like you.</p>
          <ul className="flex flex-col gap-3">
            {[
              { icon: ShieldCheck, text: "Only voice notes you approve are sent. Nothing goes out on its own." },
              { icon: Headphones, text: "Find a quiet room and hold your phone the way you record a voice note." },
              { icon: Mic, text: "It has to be your own voice, and you need to be 18 or older." },
              { icon: Trash2, text: "Delete it any time. Your recordings and the provider's copy are deleted too." },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3 text-[15px] leading-6 text-ink">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-recovered"><Icon aria-hidden size={16} /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {index !== null && (
        <TakeStep key={index} index={index as 0 | 1 | 2} statement={statement} take={takes[index] ?? null} onTake={(take) => setTake(index, take)} onClear={() => setTake(index, null)} />
      )}

      {step === "review" && (
        <div className="flex flex-col gap-3">
          <ul className="divide-y divide-hairline overflow-hidden rounded-[20px] bg-inset">
            {READS.map((read, position) => (
              <li key={read.title} className="flex items-center gap-3 px-4 py-3">
                <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", takes[position] ? "bg-brand text-on-brand" : "bg-fill text-ink-3")}><Check aria-hidden size={16} /></span>
                <span className="min-w-0 flex-1 text-[15px] font-semibold text-ink">{read.title}</span>
                <span className="text-caption text-ink-3 tabular-nums">{takes[position] ? clockDuration(takes[position]!.durationMs) : "Missing"}</span>
                <Button variant="ghost" size="sm" onClick={() => setStep(position as Step)}>Redo</Button>
              </li>
            ))}
          </ul>
          <p className={cx("text-caption", tooShort || tooLong ? "text-danger" : "text-ink-3")}>
            {tooShort
              ? `Your takes add up to ${Math.round(total / 1000)} seconds. Voice copies need at least ${totalMinMs / 1000}, so record one of them again a little slower.`
              : tooLong
                ? `Your takes add up to ${Math.round(total / 1000)} seconds. Voice copies can use up to ${totalMaxMs / 1000}, so record one of them again a little quicker.`
                : `${Math.round(total / 1000)} seconds in total. Your voice is usually ready about a minute after you upload.`}
          </p>
          {error && <p role="alert" className="text-caption text-danger">{error}</p>}
        </div>
      )}
    </Sheet>
  );
}
