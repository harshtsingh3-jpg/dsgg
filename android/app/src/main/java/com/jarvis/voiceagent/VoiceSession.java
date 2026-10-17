package com.jarvis.voiceagent;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Native voice bridge exposed to JS as window.VoiceSession.
 *
 *  STT : Android SpeechRecognizer (free-form, partial results supported)
 *  TTS : Android TextToSpeech engine
 *
 * Results are pushed into the page by calling global JS functions:
 *   onNativeSpeech(finalText)    — recognized command
 *   onNativeListeningState(bool) — mic on/off
 *   onTTSEnd()                   — speech finished (hands-free re-arms mic)
 */
public class VoiceSession {

    private final Context ctx;
    private final WebView web;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private final AtomicBoolean ttsReady = new AtomicBoolean(false);
    private volatile boolean wantListening = false;

    public VoiceSession(Context ctx, WebView web) {
        this.ctx = ctx;
        this.web = web;

        tts = new TextToSpeech(ctx, status -> {
            if (status == TextToSpeech.SUCCESS) {
                final TextToSpeech engine = tts;
                if (engine == null) return;
                int lang = engine.setLanguage(Locale.US);
                if (lang == TextToSpeech.LANG_NOT_SUPPORTED
                        || lang == TextToSpeech.LANG_MISSING_DATA) {
                    engine.setLanguage(Locale.getDefault());
                }
                engine.setSpeechRate(1.03f);
                engine.setPitch(0.9f);
                engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { js("onTTSEnd&&onTTSEnd()"); }
                    @Deprecated @Override public void onError(String id) { js("onTTSEnd&&onTTSEnd()"); }
                    @Override public void onError(String id, int errorCode) { js("onTTSEnd&&onTTSEnd()"); }
                });
                ttsReady.set(true);
            }
        });
    }

    /* ---------------- called from JS ---------------- */

    @android.webkit.JavascriptInterface
    public boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    @android.webkit.JavascriptInterface
    public void requestMic() {
        if (ctx instanceof AppCompatActivity) {
            ((AppCompatActivity) ctx).requestPermissions(
                    new String[]{ android.Manifest.permission.RECORD_AUDIO }, 42);
        }
    }

    @android.webkit.JavascriptInterface
    public void start() {
        if (!hasMicPermission()) { requestMic(); return; }
        wantListening = true;
        beginRecognize();
    }

    @android.webkit.JavascriptInterface
    public void stop() {
        wantListening = false;
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
            destroyRecognizer();
        }
        js("onNativeListeningState&&onNativeListeningState(false)");
    }

    @android.webkit.JavascriptInterface
    public void speak(final String text) {
        if (text == null || text.isEmpty()) { js("onTTSEnd&&onTTSEnd()"); return; }
        if (!ttsReady.get()) {           // engine still booting — say it when ready
            new Thread(() -> {
                long t0 = System.currentTimeMillis();
                while (!ttsReady.get() && System.currentTimeMillis() - t0 < 4000) {
                    try { Thread.sleep(100); } catch (InterruptedException e) { return; }
                }
                if (ttsReady.get()) speak(text);
                else js("onTTSEnd&&onTTSEnd()");
            }).start();
            return;
        }
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jarvis-out");
    }

    @android.webkit.JavascriptInterface
    public void cancelSpeech() {
        try { tts.stop(); } catch (Exception ignored) {}
    }

    /* ---------------- internals ---------------- */

    private void beginRecognize() {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            js("setStatus&&setStatus('No speech recognizer available on this device')");
            return;
        }
        destroyRecognizer();
        recognizer = SpeechRecognizer.createSpeechRecognizer(ctx);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                js("onNativeListeningState&&onNativeListeningState(true)");
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}

            @Override public void onError(int error) {
                // Keep the hands-free loop alive through silence/error timeouts.
                if (wantListening) {
                    web.postDelayed(() -> { if (wantListening) beginRecognize(); }, 700);
                } else {
                    js("onNativeListeningState&&onNativeListeningState(false)");
                }
            }

            @Override public void onResults(Bundle results) {
                String text = first(results);
                js("onNativeListeningState&&onNativeListeningState(false)");
                if (text != null && !text.trim().isEmpty()) {
                    js("onNativeSpeech&&onNativeSpeech('" + esc(text.trim()) + "')");
                }
                // Hands-free mode: the page re-arms us via VoiceSession.start() after TTS.
            }

            @Override public void onPartialResults(Bundle partialResults) {
                String p = first(partialResults);
                if (p != null && !p.isEmpty()) {
                    js("setStatus&&setStatus('" + esc(p) + " …')");
                }
            }

            @Override public void onEvent(int eventType, Bundle params) {}

            private String first(Bundle b) {
                if (b == null) return null;
                ArrayList<String> list =
                        b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                return (list == null || list.isEmpty()) ? null : list.get(0);
            }
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        try { recognizer.startListening(intent); }
        catch (Exception e) { js("setStatus&&setStatus('Mic busy — tap again')"); }
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try { recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
        }
    }

    private void js(String code) {
        web.post(() -> web.evaluateJavascript(code, null));
    }

    /** Escape a string for embedding inside single quotes in JS. */
    private static String esc(String s) {
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\"", "\\\"")
                .replace("\n", " ")
                .replace("\r", " ")
                .replaceAll("[<>&]", " ");
    }

    public void shutdown() {
        wantListening = false;
        destroyRecognizer();
        try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {}
    }
}
