-- SpriteCore glasses_app.lua
--
-- On-device client for the Brilliant Frame. Multiplexes mic, IMU and display
-- over the single BLE raw-data channel using the byte tags defined in
-- ai.openclaw.spritecore.client.glasses.GlassesProtocol.Channel.
--
-- Wire format (matches Kotlin GlassesClient.sendData / dispatch):
--   inbound:  [sub-channel: u8][app payload ...]
--   outbound: frame.bluetooth.send adds the 0x01 raw-data prefix; we prepend
--             our own sub-channel byte after that.

local CH_MIC          = 0x10
local CH_IMU_TAP      = 0x20
local CH_IMU_HEADING  = 0x21
local CH_BATTERY      = 0x30
local CH_DISP_BEGIN   = 0x40
local CH_DISP_CHUNK   = 0x41
local CH_DISP_COMMIT  = 0x42

local mic_running = false
local disp_x, disp_y, disp_w, disp_h = 0, 0, 0, 0
local disp_buf = ""

-- One byte of every outbound raw packet is the sub-channel tag, so the
-- mic chunk size is max_length()-1. Capped to 200 bytes as a sane default
-- when max_length() isn't queryable yet.
local function mic_chunk_size()
    local m = frame.bluetooth.max_length and frame.bluetooth.max_length() or 201
    if m < 21 then m = 21 end
    return m - 1
end

local function send(channel, payload)
    frame.bluetooth.send(string.char(channel) .. (payload or ""))
end

-- Host-callable Lua helpers ---------------------------------------------------

function mic_start(rate, depth)
    frame.microphone.start{ sample_rate = rate, bit_depth = depth }
    mic_running = true
end

function mic_stop()
    frame.microphone.stop()
    mic_running = false
end

-- IMU --------------------------------------------------------------------------

frame.imu.tap_callback(function()
    send(CH_IMU_TAP, "")
end)

-- Inbound dispatch -------------------------------------------------------------
-- Frame strips the 0x01 raw-data prefix before invoking this callback, so the
-- first byte we see is the sub-channel tag.

frame.bluetooth.receive_callback(function(data)
    if #data < 1 then return end
    local ch = string.byte(data, 1)
    local body = string.sub(data, 2)

    if ch == CH_DISP_BEGIN then
        -- 8 big-endian bytes: x, y, w, h (u16 each).
        local b1, b2, b3, b4, b5, b6, b7, b8 = string.byte(body, 1, 8)
        disp_x = b1 * 256 + b2
        disp_y = b3 * 256 + b4
        disp_w = b5 * 256 + b6
        disp_h = b7 * 256 + b8
        disp_buf = ""
    elseif ch == CH_DISP_CHUNK then
        disp_buf = disp_buf .. body
    elseif ch == CH_DISP_COMMIT then
        -- Color format 16 = 4bpp / 16-color palette per Frame Lua docs.
        frame.display.bitmap(disp_x, disp_y, disp_w, 16, 0, disp_buf)
        frame.display.show()
        disp_buf = ""
    end
end)

-- Main loop --------------------------------------------------------------------
-- One tick services mic drain + heading sample. IMU tap + inbound data are
-- handled by their callbacks above, so this loop only drives streaming work.

local heading_decim = 0
while true do
    if mic_running then
        -- Drain the on-device 32KB mic buffer aggressively. Each read returns
        -- up to N bytes; loop until empty so we never fall behind the sample
        -- rate (the 40ms tick + bounded read was the original bug).
        local sz = mic_chunk_size()
        for _ = 1, 16 do
            local chunk = frame.microphone.read(sz)
            if not chunk or #chunk == 0 then break end
            send(CH_MIC, chunk)
        end
    end

    heading_decim = heading_decim + 1
    if heading_decim >= 10 then
        heading_decim = 0
        local d = frame.imu.direction()
        if d then
            -- 3× little-endian float32. Pack manually since Frame's Lua has
            -- no string.pack on older firmwares.
            local function f32(x)
                local s, e, m
                if x == 0 then return "\0\0\0\0" end
                s = (x < 0) and 1 or 0
                x = math.abs(x)
                e = math.floor(math.log(x) / math.log(2))
                m = x / (2 ^ e) - 1
                local mant = math.floor(m * 2 ^ 23 + 0.5)
                local biased = e + 127
                local b0 = mant % 256
                local b1 = math.floor(mant / 256) % 256
                local b2 = (math.floor(mant / 65536) % 128) + (biased % 2) * 128
                local b3 = math.floor(biased / 2) + s * 128
                return string.char(b0, b1, b2, b3)
            end
            send(CH_IMU_HEADING, f32(d.roll) .. f32(d.pitch) .. f32(d.heading))
        end
    end

    frame.sleep(0.04)
end
