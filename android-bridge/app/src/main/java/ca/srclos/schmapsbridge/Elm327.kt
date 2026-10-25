package ca.srclos.schmapsbridge

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/**
 * Minimal ELM327 command/response layer over the RFCOMM serial
 * stream. Cheap clones are slow and echo characters, so every
 * exchange: sends a command, drains the echo, reads until the ">"
 * prompt, and strips the usual clone noise (NO DATA, SEARCHING…).
 */
class Elm327(private val input: InputStream, private val output: OutputStream) {

    private val reader = BufferedReader(InputStreamReader(input, Charsets.US_ASCII))

    /** Wake the adapter and put it in a known state. */
    fun initialize(): Boolean {
        // ATZ resets the clone's leftover state from whatever app used
        // it last; ATE0 kills character echo; ATL0/ATS0 drop linefeeds
        // and spaces so responses are compact; ATSP0 lets the adapter
        // auto-detect the car's protocol.
        send("ATZ")
        Thread.sleep(500) // clones need a beat after reset
        val ident = send("ATI") ?: return false
        if (!ident.contains("ELM", ignoreCase = true)) return false
        send("ATE0")
        send("ATL0")
        send("ATS0")
        send("ATSP0")
        return true
    }

    /**
     * Send one command, return its response lines (noise stripped),
     * or null on timeout / adapter trouble.
     */
    fun send(command: String): List<String>? {
        return try {
            // Drain anything the clone is still dribbling out.
            while (reader.ready()) reader.readLine()

            output.write((command + "\r").toByteArray(Charsets.US_ASCII))
            output.flush()

            val lines = mutableListOf<String>()
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(TIMEOUT_MS)
            while (System.nanoTime() < deadline) {
                val line = reader.readLine() ?: return null // stream closed
                val clean = line.trim()
                if (clean.isEmpty()) continue
                if (clean == ">") break // prompt — response complete
                if (clean.equals("NO DATA", ignoreCase = true)) return null
                if (clean.startsWith("SEARCHING", ignoreCase = true)) continue
                if (clean.startsWith("STOPPED", ignoreCase = true)) continue
                if (clean.equals(command, ignoreCase = true)) continue // echo (ATE0 not yet off)
                lines.add(clean)
            }
            if (lines.isEmpty()) null else lines
        } catch (_: IOException) {
            null
        }
    }

    /**
     * Query a standard OBD-II PID (e.g. "010C" for RPM). Returns the
     * data bytes after the "41 0C" echo of the mode+PID, or null.
     */
    fun pid(mode: String, pid: String): ByteArray? {
        val lines = send(mode + pid) ?: return null
        for (line in lines) {
            val hex = line.replace(" ", "")
            val head = mode + pid
            if (hex.length >= head.length + 2 &&
                hex.startsWith(head, ignoreCase = true)
            ) {
                val data = hex.substring(head.length)
                // Some clones pad with trailing junk; take pairs only.
                val bytes = ByteArray(data.length / 2) { i ->
                    ((Character.digit(data[i * 2], 16) shl 4) or
                        Character.digit(data[i * 2 + 1], 16)).toByte()
                }
                return bytes
            }
        }
        return null
    }

    companion object {
        private const val TIMEOUT_MS = 1500L
    }
}