package ca.srclos.schmapsbridge

import android.os.Handler
import android.os.Looper

/**
 * Process-wide bridge state, observable from the activity. A plain
 * singleton instead of a service-scoped LiveData — the activity must
 * keep observing across service restarts (e.g. after an adapter
 * error), and a static holder survives those.
 */
object BridgeState {

    sealed class State {
        object Stopped : State()
        object Connecting : State()
        data class Connected(val device: String) : State()
        data class Error(val message: String) : State()
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val listeners = mutableListOf<(State) -> Unit>()

    @Volatile
    private var current: State = State.Stopped

    fun set(s: State) {
        current = s
        val snapshot = listeners.toList()
        mainHandler.post { snapshot.forEach { it(s) } }
    }

    fun get(): State = current

    fun listen(listener: (State) -> Unit) {
        mainHandler.post {
            listeners.add(listener)
            listener(current)
        }
    }

    fun unlisten(listener: (State) -> Unit) {
        mainHandler.post { listeners.remove(listener) }
    }
}