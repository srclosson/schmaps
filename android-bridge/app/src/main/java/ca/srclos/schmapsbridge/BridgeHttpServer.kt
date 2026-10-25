package ca.srclos.schmapsbridge

import fi.iki.elonen.NanoHTTPD

/**
 * Loopback-only HTTP server. The schmaps PWA (HTTPS) polls
 * http://127.0.0.1:8080/obd.json once a second.
 *
 * Why this works at all: browsers treat 127.0.0.1 as a "potentially
 * trustworthy origin," so an HTTPS page may fetch it without tripping
 * mixed content. Chrome's Local Network Access still gates it — the
 * user sees a one-time permission prompt — and the preflight must be
 * answered with Access-Control-Allow-Private-Network: true.
 */
class BridgeHttpServer : NanoHTTPD("127.0.0.1", 8080) {

    @Volatile
    private var latest: String = "{\"connected\":false}"

    fun publish(json: String) {
        latest = json
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri

        if (uri == "/health") {
            return ok("{\"ok\":true}")
        }

        if (uri == "/obd.json") {
            // CORS for the HTTPS origin the PWA is served from.
            val origin = session.headers["origin"]
            val res = newFixedLengthResponse(latest)
            res.setMimeType("application/json")
            res.addHeader("Access-Control-Allow-Origin", origin ?: "*")
            res.addHeader("Access-Control-Allow-Private-Network", "true")
            return res
        }

        // Preflight for the private-network fetch above.
        if (session.method == Method.OPTIONS) {
            val res = newFixedLengthResponse("")
            res.addHeader("Access-Control-Allow-Origin", session.headers["origin"] ?: "*")
            res.addHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
            res.addHeader("Access-Control-Allow-Headers", "content-type")
            res.addHeader("Access-Control-Allow-Private-Network", "true")
            return res
        }

        return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found")
    }

    private fun ok(body: String): Response {
        val res = newFixedLengthResponse(body)
        res.setMimeType("application/json")
        return res
    }
}