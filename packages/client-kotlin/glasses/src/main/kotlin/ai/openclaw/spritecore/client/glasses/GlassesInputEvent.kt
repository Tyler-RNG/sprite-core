package ai.openclaw.spritecore.client.glasses

/**
 * Events the on-device Lua app forwards over [GlassesProtocol.Channel.IMU_TAP]
 * and [GlassesProtocol.Channel.IMU_HEADING]. Modelled after the wearable's
 * tap + orientation surface so an openclaw glasses app can share the same
 * upstream handler shape.
 */
sealed interface GlassesInputEvent {
    /** Single tap registered by `frame.imu.tap_callback`. */
    data object Tap : GlassesInputEvent

    /** Roll/pitch/heading in degrees, sampled at the Lua app's poll rate. */
    data class Heading(val roll: Float, val pitch: Float, val heading: Float) : GlassesInputEvent
}
