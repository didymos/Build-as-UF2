#!/usr/bin/env python3
"""Regenerates the fixtures. Inputs are deterministic; expected outputs come from uf2conv.py."""
import random, subprocess, sys, os, shutil, tempfile
here = os.path.dirname(os.path.abspath(__file__))
tool = tempfile.mkdtemp()  # uf2conv.py expects uf2families.json next to it
shutil.copy(os.path.join(here, 'uf2conv.py'), tool)
shutil.copy(os.path.join(here, '..', '..', 'src', 'uf2', 'families.json'), os.path.join(tool, 'uf2families.json'))
rnd = random.Random(0x0F2)

def rec(addr16, typ, data):
    b = bytes([len(data), addr16 >> 8, addr16 & 0xFF, typ]) + bytes(data)
    return ":" + (b + bytes([(-sum(b)) & 0xFF])).hex().upper()

def ihex(segments, ext_seg_at=None):
    lines, upper = [], None
    for base, data in segments:
        for off in range(0, len(data), 16):
            a = base + off
            if (a >> 16) != upper:
                upper = a >> 16
                lines.append(rec(0, 4, [upper >> 8, upper & 0xFF]))
            chunk = data[off:off + 16]
            # never straddle a 64K boundary within one record
            lines.append(rec(a & 0xFFFF, 0, chunk))
    lines.append(rec(0, 5, [0, 0, 0x27, 0x01]))
    lines.append(rec(0, 1, []))
    return "\r\n".join(lines) + "\r\n"

def r(n): return bytes(rnd.randrange(256) for _ in range(n))

# .bin: 1000 bytes -> 4 blocks, last one partial
open(os.path.join(here, "app.bin"), "wb").write(r(1000))
# .hex: unaligned start, gap inside a page, second segment in another 64K bank
open(os.path.join(here, "app.hex"), "w", newline="").write(ihex([
    (0x27000 + 0x10, r(300)),      # starts mid-page
    (0x27000 + 0x180, r(40)),      # gap inside page + next page
    (0x28000, r(256)),             # page aligned, exactly one page
    (0x10001000, r(48)),           # other bank (UICR-like), 0x10000000 region
]))
# .hex using extended segment address (type 02)
seg = [":020000021000EC"]  # segment 0x1000 -> base 0x10000
d = r(20); seg.append(rec(0x0004, 0, d)); seg.append(rec(0, 1, []))
open(os.path.join(here, "seg.hex"), "w", newline="").write("\n".join(seg) + "\n")

def conv(inp, fam, base=None):
    out = os.path.join(here, os.path.basename(inp) + f".{fam}.uf2")
    cmd = [sys.executable, os.path.join(tool, "uf2conv.py"), "-c", "-f", fam, "-o", out]
    if base: cmd += ["-b", base]
    subprocess.run(cmd + [os.path.join(here, inp)], check=True, stdout=subprocess.DEVNULL)

conv("app.bin", "0x68ed2b88", "0x2000")     # SAMD21
conv("app.bin", "0x0", "0x4000")            # no family flag
conv("app.hex", "0xada52840")               # NRF52840
conv("seg.hex", "0xe48bff56")               # RP2040
