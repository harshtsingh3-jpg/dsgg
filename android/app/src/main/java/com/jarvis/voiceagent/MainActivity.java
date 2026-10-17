package com.jarvis.voiceagent;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

/**
 * JARVIS Voice Agent — Android shell.
 *
 * The agent brain (plan → act → verify → replan), provider registry
 * (NVIDIA NIM / OpenRouter / Ollama / custom) and the UI live on the Node
 * server (src/web). This Activity renders that UI in a WebView and injects
 * NATIVE voice: Android SpeechRecognizer for STT and TextToSpeech for TTS,
 * exposed to JS as window.VoiceSession.
 */
public class MainActivity extends AppCompatActivity {

    public static final String DEFAULT_BASE = "http://192.168.1.100:8787";
    private static final String PREFS = "jarvis_app";
    private static final String KEY_BASE = "serverBase";

    private WebView web;
    private VoiceSession voice;
    private String base;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        base = sp.getString(KEY_BASE, DEFAULT_BASE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#060a14"));

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.getSettings().setMixedContentMode(
                android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        voice = new VoiceSession(this, web);
        web.addJavascriptInterface(voice, "VoiceSession");

        final String inject =
                "window.JARVIS_BASE='" + base.replace("'", "") + "';" +
                "window.JARVIS_NATIVE=true;";

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // Runs BEFORE the page's own scripts, so app.js sees native mode.
                web.evaluateJavascript(inject, null);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                web.evaluateJavascript(inject, null); // belt & braces
                askMicPermission();
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String desc, String failingUrl) {
                showServerDialog();   // can't reach PC — let user type its IP
            }
        });
        web.setWebChromeClient(new WebChromeClient());

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Floating "⚙ Server" button so users can point the app at their PC anytime
        TextView gear = new TextView(this);
        gear.setText("⚙ Server");
        gear.setTextColor(Color.parseColor("#3ee6c4"));
        gear.setBackgroundColor(Color.parseColor("#CC0d1526"));
        gear.setPadding(32, 18, 32, 18);
        gear.setTextSize(13f);
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        glp.gravity = Gravity.TOP | Gravity.END;
        glp.setMargins(0, dp(10), dp(10), 0);
        gear.setOnClickListener(v -> showServerDialog());
        root.addView(gear, glp);

        setContentView(root);
        web.loadUrl(base);
    }

    private void askMicPermission() {
        if (androidx.core.content.ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.RECORD_AUDIO)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ android.Manifest.permission.RECORD_AUDIO }, 42);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Called from JS if the page can't reach the server (WS/fetch failures). */
    @JavascriptInterface
    public void promptForServer() {
        runOnUiThread(this::showServerDialog);
    }

    private boolean serverDlgShown = false;
    private void showServerDialog() {
        if (isFinishing()) return;
        serverDlgShown = true;
        runOnUiThread(() -> {
            EditText input = new EditText(this);
            input.setText(base);
            input.setTextColor(Color.WHITE);
            input.setHint("http://<pc-ip>:8787");
            AlertDialog dlg = new AlertDialog.Builder(this)
                    .setTitle("JARVIS server address")
                    .setMessage("Enter the address of the computer running the JARVIS Node server (must be on the same Wi-Fi).\nExample: http://192.168.1.20:8787")
                    .setView(input)
                    .setCancelable(false)
                    .setPositiveButton("Connect", (d, w) -> {
                        String url = input.getText().toString().trim();
                        if (url.isEmpty()) url = DEFAULT_BASE;
                        if (!url.startsWith("http")) url = "http://" + url;
                        url = url.replaceAll("/+$", "");
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                .putString(KEY_BASE, url).apply();
                        base = url;
                        serverDlgShown = false;
                        voice.cancelSpeech();
                        web.loadUrl(url);
                    })
                    .setNegativeButton("Retry", (d, w) -> {
                        serverDlgShown = false;
                        web.loadUrl(base);
                    })
                    .create();
            try { dlg.show(); } catch (Exception ignored) {}
        });
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        voice.stop();
    }

    @Override
    protected void onDestroy() {
        voice.shutdown();
        super.onDestroy();
    }
}
