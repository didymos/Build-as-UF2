# UF2 Export for Arduino IDE 2.x

Compiles the current sketch for the **currently selected board** and writes
`<sketch>.<board>.uf2` into a folder you choose. No Python, no network access at runtime.

## Install

1. Build or download `uf2-export.vsix`.
2. Copy it to `~/.arduinoIDE/plugins/` (Windows: `%USERPROFILE%\.arduinoIDE\plugins\`).
3. Remove older copies of this extension from `plugins/` and `deployedPlugins/`, restart the IDE.

## Use

Click **UF2** in the status bar (bottom left), press **Ctrl+Alt+U** / **Cmd+Alt+U**, or run
"UF2: Export…". (The editor-title button does not render in Arduino IDE 2.x, the command palette
entry was not confirmed.) Choose a folder, then **Build and convert** or **Convert only**.
Log: Output panel → "UF2 Export".

## Supported boards (rules are evidence-based, not vendor-name based)

| Detected by | Input | Family | Base |
|---|---|---|---|
| `build.chip` = `rp2…` (arduino-pico) | `.uf2` built by the core | from the file | from the file |
| `-DNRF52840_XXAA` in `build.extra_flags` or `nrf52840*` linker script, plus `nrfutil` upload tool (Adafruit bootloader lineage) | `.hex` | `NRF52840` `0xada52840` | from the hex |
| `adafruit:samd`, `-D__SAMD21…__`, `flash_with_bootloader.ld` | `.bin` | `SAMD21` `0x68ed2b88` | `0x2000` (checked against the linker script when readable) |
| `adafruit:samd`, `-D__SAMD51__`, `flash_with_bootloader.ld` | `.bin` | `SAMD51` `0x55114460` | `0x4000` (idem) |

A `.uf2` produced by the core is always preferred over converting. Unknown boards abort with
`FQBN <x> has no UF2 mapping…` before any dialog. Not seeded on purpose: ESP32-S2/S3 (the app
offset depends on the partition scheme) — use an override.

Recognising a chip does not prove that your board runs a UF2 bootloader.

## Overrides

Setting `uf2export.overrides`, key = FQBN without options:

```json
{
  "uf2export.overrides": {
    "vendor:arch:board": { "familyId": "NRF52840", "input": "hex" },
    "vendor:arch:other": { "familyId": "0x68ed2b88", "baseAddress": "0x2000", "input": "bin" }
  }
}
```

`familyId`: number, `"0x…"` string or `short_name` from `uf2families.json`. `baseAddress` is only
used for `bin`. `input: "uf2"` passes the core's `.uf2` through.

## Build

Primary: the IDE's `arduino-verify-sketch` command (blocks until the build ends). Fallback
(`uf2export.buildMethod`): `arduino-cli compile` with the IDE's `arduino-cli.yaml`. An IDE build
cannot be cancelled from an extension; cancelling only stops waiting.

## Development

```
npm install
npm test            # encoder tests compare byte-for-byte with test/fixtures/uf2conv.py output
npm run package     # typecheck + tests + esbuild + vsce → uf2-export.vsix
```

Licensing: see `LICENSE` and `NOTICE` (UF2 conversion logic and family list are from microsoft/uf2, MIT).
