/**
 * Component test: the audio layer's platform seams, without any audio hardware.
 *
 * Device enumeration and the player's argument list run only on a real Mac with
 * a real microphone, which means in practice they are never exercised by a test
 * — and they are exactly the places where a silent failure hides. Both have bitten
 * this project already: ffplay rejecting `-ac` killed audio output for days
 * because every play exited 1 unseen, and picking a virtual device gives a
 * microphone that connects happily and hears nothing.
 *
 * So the parsing runs against recorded `ffmpeg -list_devices` output and the
 * argument lists are asserted directly. No devices, no permissions, no sound.
 */
import { parseAvfoundationDevices, parsePactlSources, captureArgs, playerArgs, MicCapture } from '../../src/audio.js'

// Recorded from `ffmpeg -f avfoundation -list_devices true -i ""`.
const LIST_DEVICES_OUTPUT = `
[AVFoundation indev @ 0x7f8e1c004f80] AVFoundation video devices:
[AVFoundation indev @ 0x7f8e1c004f80] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8e1c004f80] [1] Capture screen 0
[AVFoundation indev @ 0x7f8e1c004f80] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8e1c004f80] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8e1c004f80] [1] Microsoft Teams Audio
[AVFoundation indev @ 0x7f8e1c004f80] [2] BlackHole 2ch
`

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- enumeration ----
const devices = parseAvfoundationDevices(LIST_DEVICES_OUTPUT)
check(
  'only the audio devices are parsed, never the cameras',
  same(devices, [
    { index: 0, name: 'MacBook Pro Microphone' },
    { index: 1, name: 'Microsoft Teams Audio' },
    { index: 2, name: 'BlackHole 2ch' },
  ]),
  JSON.stringify(devices)
)
check('no devices at all parses to an empty list, not a crash', same(parseAvfoundationDevices(''), []))
check(
  'a machine that has never granted microphone access lists nothing',
  same(parseAvfoundationDevices('[AVFoundation indev @ 0x0] AVFoundation video devices:\n[0] FaceTime HD Camera\n'), [])
)

// ---- selection ----
// A virtual device enumerates like any other and then captures silence, so
// "connected but hears nothing" is the failure this ordering prevents.
check(
  'a real microphone is preferred over a virtual one',
  MicCapture.pickDevice(devices)?.name === 'MacBook Pro Microphone',
  MicCapture.pickDevice(devices)?.name
)
check(
  'a virtual device is never picked, even when listed first',
  MicCapture.pickDevice([
    { index: 0, name: 'Microsoft Teams Audio' },
    { index: 1, name: 'External Microphone' },
  ])?.name === 'External Microphone'
)
check(
  'only virtual devices reports nothing rather than picking one',
  MicCapture.pickDevice([
    { index: 0, name: 'BlackHole 2ch' },
    { index: 1, name: 'ZoomAudioDevice' },
  ]) === null
)
check('an unrecognised but real device is still usable', MicCapture.pickDevice([{ index: 0, name: 'Scarlett Solo' }])?.name === 'Scarlett Solo')

// ---- the argument lists (macOS) ----
const cap = captureArgs({ device: ':1', sampleRate: 24000, platform: 'darwin' })
check('capture asks avfoundation for the requested device', cap.join(' ').includes('-f avfoundation -i :1'), cap.join(' '))
check('capture requests mono PCM16 at the session rate', cap.join(' ').includes('-ar 24000 -ac 1 -f s16le'))

const play = playerArgs({ sampleRate: 24000, platform: 'darwin' })
// ffplay rejects -ac and exits 1 without playing anything, and the exit code is
// not surfaced anywhere the user would see it. This is that bug, pinned.
check('playback does NOT pass -ac, which ffplay rejects', !play.includes('-ac'), play.join(' '))
check('playback sets the channel count the way ffplay accepts', play.join(' ').includes('-ch_layout mono'))
check('playback reads raw PCM16 from the pipe at the session rate', play.join(' ').includes('-f s16le -ar 24000'))

// ---- Linux ----
// Recorded from `pactl list sources`.
const PACTL_SOURCES = `
Source #0
	State: RUNNING
	Name: alsa_input.usb-046d_0825_096D0CF0-00-U0x46d0x825.analog-stereo
	Description: Logitech USB Headset H540 Analog Stereo
	Driven by module: <31>
	Properties:
		alsa.resolution_bits = "16"
		device.api = "alsa"

Source #1
	State: RUNNING
	Name: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
	Description: Monitor of Built-in Audio Analog Stereo
	Properties:
		device.class = "monitor"
		alsa.card = "0"

Source #2
	State: RUNNING
	Name: alsa_input.pci-0000_00_1f.3.analog-stereo
	Description: Built-in Audio Analog Stereo
	Properties:
		alsa.card = "0"
`

const linuxDevices = parsePactlSources(PACTL_SOURCES)
check(
  'Linux: pactl sources are parsed, filtering out monitors',
  same(linuxDevices, [
    { index: 'alsa_input.usb-046d_0825_096D0CF0-00-U0x46d0x825.analog-stereo', name: 'Logitech USB Headset H540 Analog Stereo' },
    { index: 'alsa_input.pci-0000_00_1f.3.analog-stereo', name: 'Built-in Audio Analog Stereo' },
  ]),
  JSON.stringify(linuxDevices)
)
check('Linux: no sources at all parses to empty list', same(parsePactlSources(''), []))

// ---- Linux capture/playback args ----
const linuxCap = captureArgs({ device: 'alsa_input.pci-0000_00_1f.3.analog-stereo', sampleRate: 24000, platform: 'linux' })
check('Linux: capture uses pulse instead of avfoundation', linuxCap.join(' ').includes('-f pulse'), linuxCap.join(' '))
check('Linux: capture requests the correct source', linuxCap.join(' ').includes('-i alsa_input.pci-0000_00_1f.3.analog-stereo'))
check('Linux: capture requests mono PCM16 at the session rate', linuxCap.join(' ').includes('-ar 24000 -ac 1 -f s16le'))

const linuxPlay = playerArgs({ sampleRate: 24000, platform: 'linux' })
check('Linux: playback uses pacat args', linuxPlay.includes('--raw'), linuxPlay.join(' '))
check('Linux: playback specifies s16le format', linuxPlay.join(' ').includes('--format=s16le'))
check('Linux: playback requests mono at session rate', linuxPlay.join(' ').includes('--rate=24000') && linuxPlay.join(' ').includes('--channels=1'))
check('Linux: playback sets latency for low-delay', linuxPlay.join(' ').includes('--latency-msec=120'))

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
