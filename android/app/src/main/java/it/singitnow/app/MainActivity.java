package it.singitnow.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.CharacterStyle;
import android.text.style.UpdateAppearance;
import android.location.LocationManager;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.util.Base64;
import java.io.OutputStream;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * SingITnow sul telefono: la pagina del PC (…:8765/remote) a tutto schermo, senza barra del browser.
 *
 * L'indirizzo del PC non è scritto nell'app (cambia da rete a rete): all'avvio si riprova
 * l'ultimo usato e, se non risponde, si cerca SingITnow sulla rete Wi-Fi (porta 8765).
 * In più rispetto al browser: i tasti del volume regolano il volume della TV (amministratori).
 */
public class MainActivity extends Activity {
    private static final int PORT = 8765;
    private static final int REQ_CAMERA = 1;
    private static final int REQ_FILE = 2;
    private static final int REQ_PHOTO = 3;
    private static final int REQ_CAMERA_FOR_PHOTO = 4;
    private static final int REQ_LOCATION = 5;
    private static final int REQ_NOTIFY = 6;
    private Uri photoUri;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private View overlay;
    private boolean volumeKeys = false;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> fileCallback;
    private boolean loadedOnce = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("singitnow", MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0B14"));
        setContentView(root);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        web.setBackgroundColor(Color.parseColor("#0B0B14"));
        web.addJavascriptInterface(new Bridge(), "SingITnowApp");
        web.setWebViewClient(new WebViewClient() {
            // i link verso altri siti (es. YouTube) non escono dall'app SingITnow: li apre Android
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                Uri home = Uri.parse(web.getUrl() == null ? "" : web.getUrl());
                if (u.getHost() != null && home.getHost() != null && !u.getHost().equals(home.getHost())) {
                    openExternal(u.toString());
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadedOnce = true;
                hideOverlay();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                // il PC non risponde più (spento, altra rete): si torna a cercarlo
                if (req.isForMainFrame()) findServer(false);
            }
        });
        // file da scaricare (registrazioni delle esibizioni): dentro la WebView un link non basta
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, disposition, mime));
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // fotocamera per la foto del profilo: si chiede il permesso ad Android una volta
                main.post(() -> {
                    if (Build.VERSION.SDK_INT >= 23
                            && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        pendingPermission = request;
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                    } else {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                // «Scatta una foto» (capture): si apre direttamente la fotocamera, non la galleria
                if (params.isCaptureEnabled()) {
                    if (Build.VERSION.SDK_INT >= 23
                            && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_FOR_PHOTO);
                    } else {
                        takePhoto();
                    }
                    return true;
                }
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        String saved = prefs.getString("url", null);
        if (saved != null) {
            showMessage("Mi collego a SingITnow…", true);
            checkThen(saved, () -> open(saved), () -> findServer(true));
        } else {
            findServer(true);
        }
    }

    // ------------------------------------------------------------------ ricerca del PC

    private void open(String url) {
        prefs.edit().putString("url", url).apply();
        web.loadUrl(url);
    }

    /** Prova un indirizzo (…/remote) e poi esegue ok o ko sul thread principale. */
    private void checkThen(String remoteUrl, Runnable ok, Runnable ko) {
        new Thread(() -> {
            String base = remoteUrl.replaceAll("/remote/?$", "");
            boolean good = infoOk(base, 1500);
            main.post(good ? ok : ko);
        }).start();
    }

    /** Ricerca in corso: ogni nuova ricerca annulla la precedente (niente ricerche doppie). */
    private int searchId = 0;

    /**
     * Cerca SingITnow su tutti gli indirizzi della rete Wi-Fi (ultimo numero da 1 a 254) e,
     * se non lo trova, riprova da sola finché non compare (es. l'app sul PC viene aperta dopo).
     */
    private void findServer(boolean firstTime) {
        int id = ++searchId;
        showMessage("Cerco SingITnow sulla rete Wi-Fi…", true);
        searchLoop(id, 0);
    }

    private void searchLoop(int id, int attempt) {
        new Thread(() -> {
            // si riprova anche l'ultimo indirizzo usato: è il più probabile
            String saved = prefs.getString("url", null);
            String found = saved != null && infoOk(saved.replaceAll("/remote/?$", ""), 1500) ? saved : scan();
            main.post(() -> {
                if (id != searchId) return; // nel frattempo è partita un'altra ricerca
                if (found != null) {
                    open(found);
                    return;
                }
                if (attempt == 0) {
                    showMessage("Nessun server trovato…\n\nApri SingITnow sul PC e collega il telefono alla stessa rete.",
                            true);
                }
                main.postDelayed(() -> {
                    if (id == searchId) searchLoop(id, attempt + 1);
                }, 2000);
            });
        }).start();
    }

    private String scan() {
        List<String> prefixes = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        String prefix = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(prefix)) prefixes.add(prefix);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        AtomicReference<String> found = new AtomicReference<>();
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (String prefix : prefixes) {
            for (int i = 1; i < 255; i++) {
                String base = "http://" + prefix + i + ":" + PORT;
                pool.execute(() -> {
                    if (found.get() == null && infoOk(base, 900)) found.compareAndSet(null, base + "/remote");
                });
            }
        }
        pool.shutdown();
        try {
            pool.awaitTermination(15, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
        }
        return found.get();
    }

    /** true se all'indirizzo risponde SingITnow (/api/info contiene remote_url). */
    private static boolean infoOk(String base, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/info").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs * 2);
            if (c.getResponseCode() != 200) return false;
            try (InputStream in = c.getInputStream(); Scanner sc = new Scanner(in, "UTF-8")) {
                String body = sc.useDelimiter("\\A").hasNext() ? sc.next() : "";
                return body.contains("remote_url");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ schermata di attesa

    private void showMessage(String text, boolean spinner) {
        hideOverlay();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));
        box.setBackgroundColor(Color.parseColor("#0B0B14"));
        box.setClickable(true);

        // logo di SingITnow al centro, sopra il messaggio: microfono e scritta «SingITnow» affiancati
        // (come nella barra laterale del PC), con «IT» nella sfumatura rosa → viola → azzurro
        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.HORIZONTAL);
        brand.setGravity(Gravity.CENTER);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        LinearLayout.LayoutParams logoSize = new LinearLayout.LayoutParams(dp(56), dp(56));
        logoSize.rightMargin = dp(12);
        brand.addView(logo, logoSize);

        TextView title = new TextView(this);
        SpannableString name = new SpannableString("SingITnow");
        name.setSpan(new GradientSpan(), 4, 6, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        title.setText(name);
        title.setTextColor(Color.WHITE);
        title.setTextSize(32);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setLetterSpacing(-0.02f);
        brand.addView(title);
        box.addView(brand);

        TextView msg = new TextView(this);
        msg.setText(text);
        msg.setTextColor(Color.parseColor("#B8B8CC"));
        msg.setTextSize(16);
        msg.setGravity(Gravity.CENTER);
        msg.setPadding(0, dp(16), 0, dp(16));
        box.addView(msg);

        if (spinner) box.addView(new ProgressBar(this));
        overlay = box;
        root.addView(box, new FrameLayout.LayoutParams(-1, -1));
    }

    /** Testo colorato con la sfumatura del logo (come .grad-text nella pagina). */
    private static class GradientSpan extends CharacterStyle implements UpdateAppearance {
        @Override
        public void updateDrawState(TextPaint paint) {
            // «IT» viene dopo «Sing»: la sfumatura va dal suo inizio alla sua fine (in diagonale)
            float size = paint.getTextSize();
            float x0 = paint.measureText("Sing");
            float x1 = x0 + paint.measureText("IT");
            paint.setShader(new LinearGradient(x0, 0, x1, size,
                    new int[]{Color.parseColor("#FF3D9A"), Color.parseColor("#8B5CF6"), Color.parseColor("#22D3EE")},
                    new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
        }
    }

    private void hideOverlay() {
        if (overlay != null) {
            ((ViewGroup) overlay.getParent()).removeView(overlay);
            overlay = null;
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------ ponte con la pagina

    /** window.SingITnowApp nella pagina del telefono. */
    private void openExternal(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // nessuna app per aprire il link
        }
    }

    /** http://<PC>:8765 della pagina aperta (null se non è ancora caricata). */
    private String serverBase() {
        String url = web.getUrl();
        if (url == null) url = prefs.getString("url", null);
        if (url == null) return null;
        Uri u = Uri.parse(url);
        if (u.getScheme() == null || u.getHost() == null) return null;
        return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    /** Android 13+: le notifiche vanno permesse esplicitamente. */
    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    /**
     * Senza questa esenzione, dopo un po' a schermo spento Android toglie la rete alle app («Doze») e
     * l'avviso arriverebbe in ritardo. Si chiede una volta sola.
     */
    private void askBatteryExemption() {
        if (Build.VERSION.SDK_INT < 23 || prefs.getBoolean("asked_battery", false)) return;
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        prefs.edit().putBoolean("asked_battery", true).apply();
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // alcuni telefoni non hanno questa schermata
        }
    }

    /**
     * Scarica un file chiesto dalla pagina. Da Android 10 lo fa il sistema (cartella Download, con la
     * notifica); prima servirebbe il permesso di scrittura: lo si apre nel browser, che lo scarica.
     */
    private void download(String url, String disposition, String mime) {
        if (url == null || !url.startsWith("http")) return;
        String name = URLUtil.guessFileName(url, disposition, mime);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                        .setTitle(name)
                        .setMimeType(mime)
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "Scaricamento di «" + name + "» nella cartella Download", Toast.LENGTH_LONG).show();
                return;
            } catch (Exception ignored) {
                // si ripiega sul browser
            }
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            Toast.makeText(this, "Download non riuscito", Toast.LENGTH_LONG).show();
        }
    }

    private class Bridge {
        /**
         * Salva un file creato dalla pagina (l'immagine delle statistiche della serata) in
         * Immagini/SingITnow. Restituisce true se è stato salvato (da Android 10).
         */
        @JavascriptInterface
        public boolean saveFile(String base64, String name, String mime) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/SingITnow");
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return false;
                    out.write(data);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** La pagina chiede i tasti del volume (amministratore con un brano in corso). */
        @JavascriptInterface
        public void setVolumeKeys(boolean on) {
            volumeKeys = on;
        }

        @JavascriptInterface
        public String version() {
            return "6"; // 6: download delle registrazioni e salvataggio delle immagini
        }

        /**
         * Chi usa il telefono (nome e cognome): da qui in poi l'app lo avvisa quando tocca a lui,
         * anche con lo schermo spento (vedi TurnService).
         */
        @JavascriptInterface
        public void setIdentity(String first, String last) {
            main.post(() -> {
                String base = serverBase();
                if (base == null || first == null || first.trim().isEmpty()) return;
                askNotifications();
                askBatteryExemption();
                TurnService.start(MainActivity.this, base, first.trim(), last == null ? "" : last.trim());
                keepPageAlive(true);
            });
        }

        /** Uscito dalla festa: niente più avvisi. */
        @JavascriptInterface
        public void clearIdentity() {
            main.post(() -> {
                TurnService.stop(MainActivity.this);
                keepPageAlive(false);
            });
        }

        /** Link esterno (es. il video su YouTube da controllare): lo apre l'app YouTube o il browser. */
        @JavascriptInterface
        public void openUrl(String url) {
            main.post(() -> openExternal(url));
        }

        /**
         * Nome della rete Wi-Fi a cui è collegato il telefono (per il QR degli ospiti). La risposta arriva
         * alla pagina con l'evento "singitnow-wifi": {ssid, security, hidden} oppure {error}.
         * La password Android non la dà a nessuna app: va scritta a mano.
         */
        @JavascriptInterface
        public void detectWifi() {
            main.post(MainActivity.this::detectWifiNow);
        }

        /** «Cambia PC»: dimentica l'indirizzo e ricerca SingITnow sulla rete. */
        @JavascriptInterface
        public void changeServer() {
            main.post(() -> {
                prefs.edit().remove("url").apply();
                findServer(false);
            });
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            int dir = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? 1 : -1;
            web.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('singitnow-volume',{detail:" + dir + "}))", null);
            return true; // il volume del telefono resta com'è
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && overlay == null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (volumeKeys && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    /** Apre l'app della fotocamera; la foto finisce in PhotoProvider e poi va alla pagina. */
    private void takePhoto() {
        photoUri = PhotoProvider.uriFor("foto_" + System.currentTimeMillis() + ".jpg");
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        i.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
        i.setClipData(ClipData.newRawUri("foto", photoUri));
        i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_PHOTO);
        } catch (Exception e) {
            // nessuna app fotocamera: si ripiega sulla galleria
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
            try {
                startActivityForResult(pick, REQ_FILE);
            } catch (Exception e2) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
        }
    }

    // ------------------------------------------------------------------ rete Wi-Fi del telefono

    private void detectWifiNow() {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            return;
        }
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 28 && lm != null && !lm.isLocationEnabled()) {
            sendWifiError("Attiva la posizione (localizzazione) del telefono e riprova: Android la richiede per leggere il nome della rete");
            return;
        }
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        WifiInfo info = wm == null ? null : wm.getConnectionInfo();
        String ssid = info == null ? null : info.getSSID();
        if (ssid == null || ssid.isEmpty() || ssid.equals(WifiManager.UNKNOWN_SSID)) {
            sendWifiError("Non trovo la rete: controlla che il telefono sia collegato al Wi-Fi e che la posizione sia attiva");
            return;
        }
        if (ssid.startsWith("\"") && ssid.endsWith("\"") && ssid.length() >= 2) ssid = ssid.substring(1, ssid.length() - 1);
        String security = "WPA";
        if (Build.VERSION.SDK_INT >= 31) {
            int t = info.getCurrentSecurityType();
            if (t == WifiInfo.SECURITY_TYPE_OPEN || t == WifiInfo.SECURITY_TYPE_OWE) security = "nopass";
            else if (t == WifiInfo.SECURITY_TYPE_WEP) security = "WEP";
        }
        try {
            JSONObject o = new JSONObject();
            o.put("ssid", ssid);
            o.put("security", security);
            o.put("hidden", info.getHiddenSSID());
            sendWifi(o);
        } catch (Exception e) {
            sendWifiError("Non riesco a leggere la rete Wi-Fi");
        }
    }

    private void sendWifiError(String msg) {
        try {
            sendWifi(new JSONObject().put("error", msg));
        } catch (Exception ignored) {
        }
    }

    private void sendWifi(JSONObject detail) {
        web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('singitnow-wifi',{detail:" + detail + "}))", null);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_LOCATION) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) detectWifiNow();
            else sendWifiError("Senza il permesso di posizione Android non dà il nome della rete: scrivilo a mano");
            return;
        }
        if (code == REQ_CAMERA_FOR_PHOTO) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                takePhoto();
            } else if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
            return;
        }
        if (code == REQ_CAMERA && pendingPermission != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pendingPermission.grant(pendingPermission.getResources());
            } else {
                pendingPermission.deny();
            }
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_PHOTO && fileCallback != null) {
            fileCallback.onReceiveValue(result == RESULT_OK && photoUri != null ? new Uri[]{photoUri} : null);
            fileCallback = null;
            return;
        }
        if (code == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    /**
     * Schermo spento o app in secondo piano. Con il servizio degli avvisi acceso (si è nella festa)
     * la pagina continua a girare: resta collegata al PC e al risveglio è già aggiornata. Senza,
     * Android abbasserebbe la priorità del processo della pagina fino a congelarlo.
     */
    @Override
    protected void onPause() {
        if (!TurnService.active) web.onPause();
        super.onPause();
    }

    /** La pagina resta importante anche quando non si vede (solo mentre si è nella festa). */
    void keepPageAlive(boolean on) {
        if (Build.VERSION.SDK_INT >= 26) {
            web.setRendererPriorityPolicy(
                    on ? WebView.RENDERER_PRIORITY_IMPORTANT : WebView.RENDERER_PRIORITY_WAIVED, !on);
        }
    }
}
