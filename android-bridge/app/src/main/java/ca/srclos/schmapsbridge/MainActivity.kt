package ca.srclos.schmapsbridge

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat

/**
 * One screen: start/stop the bridge, watch the live state. Everything
 * real happens in [BridgeService]; this activity is just the switch.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button

    private val stateListener: (BridgeState.State) -> Unit = { render(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.status)
        toggleButton = findViewById(R.id.toggle)

        toggleButton.setOnClickListener {
            if (BridgeService.isRunning) {
                BridgeService.stop(this)
            } else {
                requestBluetoothThenStart()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        BridgeState.listen(stateListener)
    }

    override fun onPause() {
        BridgeState.unlisten(stateListener)
        super.onPause()
    }

    private fun render(s: BridgeState.State) {
        toggleButton.text =
            if (BridgeService.isRunning) getString(R.string.stop) else getString(R.string.start)
        statusText.text = when (s) {
            BridgeState.State.Stopped -> getString(R.string.stopped)
            BridgeState.State.Connecting -> getString(R.string.connecting)
            is BridgeState.State.Connected -> getString(R.string.connected_fmt, s.device)
            is BridgeState.State.Error -> getString(R.string.error_fmt, s.message)
        }
    }

    private fun requestBluetoothThenStart() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isEmpty()) {
            BridgeService.start(this)
        } else {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 1)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1 &&
            grantResults.isNotEmpty() &&
            grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        ) {
            BridgeService.start(this)
        }
    }
}