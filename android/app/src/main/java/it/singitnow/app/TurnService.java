package it.singitnow.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Scanner;

/**
 * Avviso «Tocca a te!» anche con il telefono in standby.
 *
 * Con lo schermo spento Android sospende la pagina di SingITnow (e la sua connessione con il PC):
 * questo servizio resta attivo (con una notifica fissa, come vuole Android) e ogni pochi secondi
 * chiede al PC se tocca a chi usa il telefono. Quando tocca a lui accende lo schermo, vibra e mostra
 * una notifica: toccandola si apre SingITnow.
 *
 * Si ferma uscendo dalla festa («Esci» nel profilo), con «Smetti» nella notifica, o se il PC non
 * risponde per mezz'ora (festa finita).
 */
public class TurnService extends Service {
    static final String ACTION_STOP = "it.singitnow.app.STOP_TURN";
    private static final String CH_ON = "singitnow_on";
    private static final String CH_TURN = "singitnow_turn";
    private static final int ID_ON = 1;
    private static final int ID_TURN = 2;
    private static final long POLL_MS = 5000;
    private static final long GIVE_UP_MS = 30 * 60 * 1000L; // PC irraggiungibile da tanto: festa finita
    private static final long MAX_MS = 6 * 3600 * 1000L;

    /** Servizio acceso: la pagina di SingITnow resta collegata al PC anche a schermo spento. */
    static volatile boolean active;
    private volatile boolean running;
    private Thread worker;
    private PowerManager.WakeLock cpu;

    /** Avvia (o aggiorna) il servizio per questa persona su questo PC. */
    static void start(Context ctx, String base, String first, String last) {
        ctx.getSharedPreferences("singitnow", MODE_PRIVATE).edit()
                .putString("turn_base", base).putString("turn_first", first).putString("turn_last", last).apply();
        Intent i = new Intent(ctx, TurnService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.getSharedPreferences("singitnow", MODE_PRIVATE).edit()
                .remove("turn_first").remove("turn_last").apply();
        ctx.stopService(new Intent(ctx, TurnService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        channels();
        Notification on = builder(CH_ON)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle("SingITnow")
                .setContentText("Ti avviso quando tocca a te, anche a schermo spento")
                .setOngoing(true)
                .setContentIntent(openApp())
                .addAction(new Notification.Action.Builder((android.graphics.drawable.Icon) null, "Smetti",
                        PendingIntent.getService(this, 1, new Intent(this, TurnService.class).setAction(ACTION_STOP),
                                PendingIntent.FLAG_IMMUTABLE)).build())
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_ON, on, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ID_ON, on);
        }
        if (cpu == null) {
            // il processore non si addormenta: senza, a schermo spento i controlli si fermerebbero
            cpu = ((PowerManager) getSystemService(POWER_SERVICE))
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "singitnow:turn");
            cpu.acquire(MAX_MS);
        }
        if (worker == null) {
            running = true;
            worker = new Thread(this::loop, "singitnow-turn");
            worker.start();
        }
        return START_STICKY;
    }

    private void loop() {
        SharedPreferences prefs = getSharedPreferences("singitnow", MODE_PRIVATE);
        String notifiedNext = prefs.getString("turn_next", "");
        String notifiedStage = prefs.getString("turn_stage", "");
        long lastOk = System.currentTimeMillis();
        while (running) {
            String base = prefs.getString("turn_base", null);
            String first = prefs.getString("turn_first", null);
            String last = prefs.getString("turn_last", "");
            if (base == null || first == null || first.isEmpty()) break;
            try {
                JSONObject t = get(base + "/api/turn?first=" + Uri.encode(first) + "&last=" + Uri.encode(last));
                lastOk = System.currentTimeMillis();
                String state = t.optString("state");
                String entry = t.optString("entry");
                String title = t.optString("title");
                if ("next".equals(state) && !entry.equals(notifiedNext)) {
                    notifiedNext = entry;
                    prefs.edit().putString("turn_next", entry).apply();
                    alert("Preparati, tocca a te!", "«" + title + "» parte tra poco: vai verso il palco 🎤");
                } else if ("stage".equals(state) && !entry.equals(notifiedStage)) {
                    notifiedStage = entry;
                    prefs.edit().putString("turn_stage", entry).apply();
                    alert("È il tuo turno: sali sul palco!", "Sta partendo «" + title + "»");
                }
            } catch (Exception e) {
                if (System.currentTimeMillis() - lastOk > GIVE_UP_MS) break;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                break;
            }
        }
        running = false;
        stopForeground(true);
        stopSelf();
    }

    private JSONObject get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(3000);
        try (InputStream in = c.getInputStream(); Scanner sc = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
            return new JSONObject(sc.hasNext() ? sc.next() : "{}");
        } finally {
            c.disconnect();
        }
    }

    /** Accende lo schermo, vibra e mostra la notifica (toccandola si apre SingITnow). */
    private void alert(String title, String text) {
        Notification n = builder(CH_TURN)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle(title)
                .setContentText(text)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_TURN, n);
        try {
            @SuppressWarnings("deprecation")
            PowerManager.WakeLock screen = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "singitnow:screen");
            screen.acquire(10_000);
        } catch (Exception ignored) {
            // alcuni telefoni non lo permettono: restano notifica e vibrazione
        }
        Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (v != null) {
            long[] pattern = {0, 700, 250, 700, 250, 700};
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, -1));
            else v.vibrate(pattern, -1);
        }
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder builder(String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(this, channel);
        Notification.Builder b = new Notification.Builder(this);
        // prima di Android 8 l'importanza si dà alla notifica, non al canale
        b.setPriority(CH_TURN.equals(channel) ? Notification.PRIORITY_HIGH : Notification.PRIORITY_MIN);
        if (CH_TURN.equals(channel)) b.setDefaults(Notification.DEFAULT_VIBRATE | Notification.DEFAULT_SOUND);
        return b;
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel on = new NotificationChannel(CH_ON, "Attiva durante la festa", NotificationManager.IMPORTANCE_MIN);
        on.setShowBadge(false);
        nm.createNotificationChannel(on);
        NotificationChannel turn = new NotificationChannel(CH_TURN, "Tocca a te", NotificationManager.IMPORTANCE_HIGH);
        turn.enableVibration(true);
        turn.setVibrationPattern(new long[] {0, 700, 250, 700, 250, 700});
        turn.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(turn);
    }

    @Override
    public void onDestroy() {
        active = false;
        running = false;
        if (worker != null) worker.interrupt();
        worker = null;
        if (cpu != null && cpu.isHeld()) cpu.release();
        cpu = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
