package ca.srclos.schmapsbridge

/**
 * Polls the car's PIDs once per cycle and keeps the latest values.
 *
 * Only standard PIDs — every car supports these:
 *   010C  RPM            ((A*256)+B)/4
 *   010D  Speed (km/h)   A
 *   0105  Coolant (°C)   A-40
 *   015E  Fuel rate (L/h)  (256*A+B)/20  — supported by most 2008+ cars
 *
 * "km till empty" is computed on the phone's schmaps side (tank size
 * is a user setting there); the bridge just ships the raw feed.
 */
class Poller(private val elm: Elm327) {

    @Volatile var rpm: Int? = null
        private set
    @Volatile var speedKmh: Int? = null
        private set
    @Volatile var coolantC: Int? = null
        private set
    @Volatile var fuelRateLh: Double? = null
        private set
    @Volatile var connected: Boolean = false
        private set

    fun pollOnce() {
        connected = true
        rpm = elm.pid("01", "0C")?.let { b ->
            if (b.size >= 2) ((b[0].toInt() and 0xFF) * 256 + (b[1].toInt() and 0xFF)) / 4 else null
        }
        speedKmh = elm.pid("01", "0D")?.let { b ->
            if (b.isNotEmpty()) b[0].toInt() and 0xFF else null
        }
        coolantC = elm.pid("01", "05")?.let { b ->
            if (b.isNotEmpty()) (b[0].toInt() and 0xFF) - 40 else null
        }
        fuelRateLh = elm.pid("01", "5E")?.let { b ->
            if (b.size >= 2) ((b[0].toInt() and 0xFF) * 256 + (b[1].toInt() and 0xFF)) / 20.0 else null
        }
    }

    /** JSON snapshot for the HTTP server. Nulls stay null — the PWA shows "—". */
    fun snapshot(): String {
        fun opt(v: Any?): String = v?.toString() ?: "null"
        return buildString {
            append("{\"rpm\":")
            append(opt(rpm))
            append(",\"speedKmh\":")
            append(opt(speedKmh))
            append(",\"coolantC\":")
            append(opt(coolantC))
            append(",\"fuelRateLh\":")
            append(opt(fuelRateLh))
            append(",\"connected\":")
            append(connected)
            append('}')
        }
    }
}