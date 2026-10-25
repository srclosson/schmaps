package ca.srclos.schmapsbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The whole bridge in one foreground service:
 *
 *   ELM327 (classic Bluetooth SPP) ──RFCOMM──▶ this service
 *        ──HTTP on 127.0.0.1:8080──▶ Chrome ──▶ schmaps gauge strip
 *
 * A foreground service (persistent notification) is what keeps the
 * Bluetooth socket alive while the screen is off and the phone is
 * pocketed. The HTTP server binds loopback only — the feed never
 * leaves the phone.
 */
class BridgeService : Service() {

    private var worker: Thread? = null
    private var http: BridgeHttpServer? = null
    private var socket: BluetoothSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (running.getAndSet(true)) return START_STICKY

        startInForeground("Connecting…")
        BridgeState.set(BridgeState.Connecting)

        http = BridgeHttpServer().also { it.start() }

        worker = Thread { runBridge() }.apply {
            name = "obd-bridge"
            start()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        worker?.interrupt()
        worker = null
        closeSocket()
        try {
            http?.stop()
        } catch (_: Exception) {
        }
        http = null
        BridgeState.set(BridgeState.Stopped)
        super.onDestroy()
    }

    /* ---------------- device selection ---------------- */

    /**
     * Pick the paired device that looks like an ELM327. Cheap clones
     * name themselves "OBDII", "OBD2", "ELM327", "V-LINK", "VEEPEAK"…
     * If nothing matches, fall back to the first paired device — most
     * phones have exactly one thing plugged into a car.
     */
    private fun findAdapter(): BluetoothDevice? {
        val bm = getSystemService(BluetoothManager::class.java) ?: return null
        val adapter: BluetoothAdapter = bm.adapter ?: return null
        if (!adapter.isEnabled) return null
        val bonded = adapter.bondedDevices ?: return null
        if (bonded.isEmpty()) return null
        val obdNames = listOf("OBD", "ELM", "V-LINK", "VEEPEAK", "VGATE", "ICAR", "OBDLINK")
        return bonded.firstOrNull { d ->
            obdNames.any { d.name?.contains(it, ignoreCase = true) == true }
        } ?: bonded.first()
    }

    /* ---------------- main loop ---------------- */

    private fun runBridge() {
        val device = findAdapter()
        if (device == null) {
            fail("No paired Bluetooth device — pair the ELM327 in Android settings first.")
            return
        }

        // Classic Bluetooth SPP — the UUID every ELM327 clone uses.
        val uuid = device.uuids.firstOrNull { it.uuid == SPP_UUID }?.uuid ?: SPP_UUID
        val elm: Elm327
        try {
            val s = device.createRfcommSocketToServiceRecord(uuid)
            s.connect() // blocks; can take a few seconds
            socket = s
            elm = Elm327(s.inputStream, s.outputStream)
        } catch (e: Exception) {
            closeSocket()
            fail("Could not connect to ${device.name ?: device.address}: ${e.message}")
            return
        }

        try {
            if (!elm.initialize()) {
                fail("Adapter answered, but not like an ELM327 — is it plugged in and the ignition on?")
                return
            }
            val name = device.name ?: device.address
            BridgeState.set(BridgeState.Connected(name))
            updateNotification("Connected to $name — feeding schmaps")

            val poller = Poller(elm)
            while (running.get()) {
                poller.pollOnce()
                http?.publish(poller.snapshot())
                Thread.sleep(POLL_INTERVAL_MS)
            }
        } catch (_: InterruptedException) {
            // stopSelf() — normal shutdown
        } catch (e: Exception) {
            fail("Lost the adapter: ${e.message}")
        } finally {
            closeSocket()
        }
    }

    private fun fail(message: String) {
        running.set(false)
        BridgeState.set(BridgeState.Error(message))
        updateNotification(message)
        stopSelf()
    }

    private fun closeSocket() {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        socket = null
    }

    /* ---------------- notification ---------------- */

    private fun startInForeground(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                buildNotification(text),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(text))
        }
    }

    private fun buildNotification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "OBD bridge", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else 0
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, BridgeService::class.java).setAction(ACTION_STOP),
            flags
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Schmaps OBD bridge")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(stopIntent)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        private const val CHANNEL_ID = "schmaps_bridge"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "ca.srclos.schmapsbridge.STOP"
        private const val POLL_INTERVAL_MS = 1000L

        /** The standard Serial Port Profile UUID every ELM327 clone speaks. */
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        /** Process-wide: true while the bridge loop is alive. */
        private val running = AtomicBoolean(false)

        val isRunning: Boolean get() = running.get()

        fun start(context: Context) {
            context.startForegroundService(Intent(context, BridgeService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, BridgeService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}