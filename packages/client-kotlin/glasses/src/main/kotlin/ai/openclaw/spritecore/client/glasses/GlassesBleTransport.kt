package ai.openclaw.spritecore.client.glasses

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicReference

/**
 * Low-level BLE GATT client for a single Brilliant Frame.
 *
 * Owns the [BluetoothGatt] handle and the single TX/RX characteristic pair
 * defined in [GlassesProtocol]. Higher layers ([GlassesClient]) own framing
 * and dispatch — this class only moves bytes.
 *
 * Bonding is OS-driven on first connect; the user must accept the system
 * pairing dialog. Frame requires this and the docs warn that unpair requires
 * a physical pinhole press on the dock.
 */
@SuppressLint("MissingPermission")
class GlassesBleTransport(
    private val context: Context,
    private val device: BluetoothDevice,
) {
    private val gattRef = AtomicReference<BluetoothGatt?>(null)
    private val txRef = AtomicReference<BluetoothGattCharacteristic?>(null)

    private val writeMutex = Mutex()
    private var pendingWrite: CompletableDeferred<Unit>? = null
    private var pendingMtu: CompletableDeferred<Int>? = null
    private var pendingConnect: CompletableDeferred<Unit>? = null

    private val _incoming = MutableSharedFlow<ByteArray>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    /** Every notification payload from the RX characteristic, in arrival order. */
    val incoming: SharedFlow<ByteArray> = _incoming.asSharedFlow()

    @Volatile
    var maxWriteLength: Int = 20
        private set

    suspend fun connect(): Unit {
        val deferred = CompletableDeferred<Unit>()
        pendingConnect = deferred
        val gatt = device.connectGatt(context, /* autoConnect = */ false, callback)
            ?: error("connectGatt returned null")
        gattRef.set(gatt)
        deferred.await()
    }

    /** Requests a larger MTU and returns the granted size. Brilliant supports up to 251. */
    suspend fun negotiateMtu(requested: Int = 251): Int {
        val gatt = gattRef.get() ?: error("not connected")
        val deferred = CompletableDeferred<Int>()
        pendingMtu = deferred
        check(gatt.requestMtu(requested)) { "requestMtu rejected" }
        val granted = deferred.await()
        // Reserve 3 bytes for ATT header + 1 for 0x01 raw-data prefix when sending data.
        maxWriteLength = (granted - GlassesProtocol.RAW_DATA_OVERHEAD).coerceAtLeast(20)
        return granted
    }

    suspend fun write(payload: ByteArray) {
        writeMutex.withLock {
            val gatt = gattRef.get() ?: error("not connected")
            val tx = txRef.get() ?: error("TX characteristic not discovered")
            val deferred = CompletableDeferred<Unit>()
            pendingWrite = deferred
            tx.value = payload
            tx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            check(gatt.writeCharacteristic(tx)) { "writeCharacteristic rejected" }
            deferred.await()
        }
    }

    fun close() {
        gattRef.getAndSet(null)?.close()
        txRef.set(null)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                pendingConnect?.completeExceptionally(IllegalStateException("disconnected: $status"))
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val service = gatt.getService(GlassesProtocol.SERVICE_UUID)
            val tx = service?.getCharacteristic(GlassesProtocol.TX_CHARACTERISTIC)
            val rx = service?.getCharacteristic(GlassesProtocol.RX_CHARACTERISTIC)
            if (tx == null || rx == null) {
                pendingConnect?.completeExceptionally(
                    IllegalStateException("Brilliant service/characteristics not found")
                )
                return
            }
            txRef.set(tx)
            gatt.setCharacteristicNotification(rx, true)
            // CCCD write actually enables notifications on the peer side.
            val cccd = rx.getDescriptor(GlassesProtocol.CCCD)
            cccd?.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            if (cccd != null) {
                gatt.writeDescriptor(cccd)
            } else {
                pendingConnect?.complete(Unit)
            }
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (descriptor.uuid == GlassesProtocol.CCCD) {
                pendingConnect?.complete(Unit)
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            pendingMtu?.complete(mtu)
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (characteristic.uuid == GlassesProtocol.TX_CHARACTERISTIC) {
                pendingWrite?.complete(Unit)
            }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            if (characteristic.uuid == GlassesProtocol.RX_CHARACTERISTIC) {
                _incoming.tryEmit(characteristic.value.copyOf())
            }
        }
    }
}
