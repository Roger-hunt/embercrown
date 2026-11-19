#!/usr/bin/env python3
"""Build optimized GLB models and complete M4A/OGG SFX from AssetsFree/ into public/assets/."""

import io
import json
import os
import struct
import subprocess
import tempfile
import wave
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_FREE = os.path.join(ROOT, "AssetsFree")
OUT_MODELS = os.path.join(ROOT, "public", "assets", "models")
OUT_SFX = os.path.join(ROOT, "public", "assets", "sfx")


def pack_gltf_to_glb(zf: zipfile.ZipFile, gltf_path: str, out_glb_path: str) -> None:
    """Convert a .gltf + external .bin + external .png inside a zip into a self-contained .glb."""
    base_dir = os.path.dirname(gltf_path)
    gltf = json.loads(zf.read(gltf_path).decode("utf-8"))

    bin_chunks = []
    buf_offsets = []
    total_len = 0
    for buf in gltf.get("buffers", []):
        uri = buf.get("uri", "")
        raw = zf.read(os.path.join(base_dir, uri))
        pad = (4 - (len(raw) % 4)) % 4
        bin_chunks.append(raw + b"\x00" * pad)
        buf_offsets.append(total_len)
        total_len += len(raw) + pad
        buf.pop("uri", None)
        buf["byteLength"] = len(raw)

    for bv in gltf.get("bufferViews", []):
        bi = bv.get("buffer", 0)
        bv["byteOffset"] = bv.get("byteOffset", 0) + buf_offsets[bi]
        bv["buffer"] = 0

    bvs = gltf.setdefault("bufferViews", [])
    for img in gltf.get("images", []):
        uri = img.get("uri", "")
        if not uri:
            continue
        img_bytes = zf.read(os.path.join(base_dir, uri))
        pad = (4 - (len(img_bytes) % 4)) % 4
        bv_idx = len(bvs)
        bvs.append({
            "buffer": 0,
            "byteOffset": total_len,
            "byteLength": len(img_bytes),
        })
        bin_chunks.append(img_bytes + b"\x00" * pad)
        total_len += len(img_bytes) + pad
        img.pop("uri", None)
        img["bufferView"] = bv_idx
        if not img.get("mimeType"):
            img["mimeType"] = "image/png"

    if gltf.get("buffers"):
        gltf["buffers"] = [{"byteLength": total_len}]

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_chunk = json_bytes + b" " * json_pad

    bin_chunk = b"".join(bin_chunks)
    total_file_len = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)

    with open(out_glb_path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total_file_len))
        f.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
        f.write(json_chunk)
        f.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
        f.write(bin_chunk)


def build_models() -> None:
    os.makedirs(OUT_MODELS, exist_ok=True)
    adv_zip = os.path.join(ASSETS_FREE, "KayKit_Adventurers_2.0_FREE.zip")
    skel_zip = os.path.join(ASSETS_FREE, "KayKit_Skeletons_1.1_FREE.zip")
    wpn_zip = os.path.join(ASSETS_FREE, "KayKit_FantasyWeaponsBits_1.0_FREE.zip")

    with zipfile.ZipFile(adv_zip) as za, zipfile.ZipFile(skel_zip) as zs, zipfile.ZipFile(wpn_zip) as zw:
        adv_chars = ["Knight", "Ranger", "Mage", "Rogue", "Rogue_Hooded", "Barbarian"]
        for c in adv_chars:
            data = za.read(f"KayKit_Adventurers_2.0_FREE/Characters/gltf/{c}.glb")
            with open(os.path.join(OUT_MODELS, f"{c}.glb"), "wb") as f:
                f.write(data)

        skel_chars = ["Skeleton_Minion", "Skeleton_Rogue", "Skeleton_Mage", "Skeleton_Warrior"]
        for c in skel_chars:
            data = zs.read(f"KayKit_Skeletons_1.1_FREE/characters/gltf/{c}.glb")
            with open(os.path.join(OUT_MODELS, f"{c}.glb"), "wb") as f:
                f.write(data)

        adv_props = [
            "sword_1handed", "sword_2handed_color", "shield_badge_color",
            "shield_spikes_color", "bow_withString", "staff", "dagger",
            "spellbook_open", "axe_2handed",
        ]
        for p in adv_props:
            pack_gltf_to_glb(
                za,
                f"KayKit_Adventurers_2.0_FREE/Assets/gltf/{p}.gltf",
                os.path.join(OUT_MODELS, f"{p}.glb"),
            )

        pack_gltf_to_glb(
            zs,
            "KayKit_Skeletons_1.1_FREE/assets/gltf/Skeleton_Staff.gltf",
            os.path.join(OUT_MODELS, "Skeleton_Staff.glb"),
        )

        for p in ["hammer_C", "spear_A"]:
            pack_gltf_to_glb(
                zw,
                f"KayKit_FantasyWeaponsBits_1.0_FREE/Assets/gltf/{p}.gltf",
                os.path.join(OUT_MODELS, f"{p}.glb"),
            )

    print(f"Built {len(os.listdir(OUT_MODELS))} GLB models in {OUT_MODELS}")


def trim_and_encode_wav(raw_bytes: bytes, out_m4a: str, max_dur: float = None, fade_out: float = 0.12, lowpass_alpha: float = None) -> None:
    """Trim trailing silence (and optional max_dur with fade out), optional lowpass smoothing, normalize peak, encode to M4A via afconvert."""
    with wave.open(io.BytesIO(raw_bytes), "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        rate = w.getframerate()
        nframes = w.getnframes()
        pcm = w.readframes(nframes)

    if sw != 2:
        raise ValueError(f"Unsupported sample width {sw}")

    samples = list(struct.unpack(f"<{nframes * ch}h", pcm))

    thresh = 160
    start_f = 0
    for i in range(0, len(samples), ch):
        if max(abs(samples[i + c]) for c in range(ch)) > thresh:
            start_f = max(0, (i // ch) - int(0.01 * rate))
            break

    end_f = nframes
    for i in range(len(samples) - ch, -1, -ch):
        if max(abs(samples[i + c]) for c in range(ch)) > thresh:
            end_f = min(nframes, (i // ch) + int(0.06 * rate))
            break

    if max_dur is not None:
        end_f = min(end_f, start_f + int(max_dur * rate))

    if end_f <= start_f:
        end_f = min(nframes, start_f + int(0.3 * rate))

    sliced = samples[start_f * ch : end_f * ch]
    total_f = len(sliced) // ch

    mono = []
    for i in range(0, len(sliced), ch):
        mono.append(sum(sliced[i : i + ch]) / ch)

    if lowpass_alpha is not None and mono:
        lp = mono[0]
        for i in range(len(mono)):
            lp = lp + lowpass_alpha * (mono[i] - lp)
            mono[i] = lp

    fi = min(total_f, int(0.005 * rate))
    fo = min(total_f, int(fade_out * rate))
    for i in range(fi):
        mono[i] *= i / max(1, fi)
    for i in range(fo):
        mono[total_f - 1 - i] *= i / max(1, fo)

    peak = max((abs(x) for x in mono), default=1.0)
    scale = (0.88 * 32767.0) / peak if peak > 100 else 1.0
    out_pcm = struct.pack(
        f"<{total_f}h",
        *[max(-32767, min(32767, int(round(x * scale)))) for x in mono],
    )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp_wav = tf.name
    try:
        with wave.open(tmp_wav, "wb") as wo:
            wo.setnchannels(1)
            wo.setsampwidth(2)
            wo.setframerate(rate)
            wo.writeframes(out_pcm)
        subprocess.run(
            ["/usr/bin/afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", tmp_wav, out_m4a],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)


def build_sfx() -> None:
    os.makedirs(OUT_SFX, exist_ok=True)
    for old_f in ["swing.ogg", "cleave.ogg"]:
        p = os.path.join(OUT_SFX, old_f)
        if os.path.exists(p):
            os.remove(p)
    spells_zip = os.path.join(ASSETS_FREE, "spells.zip")
    spell_mapping = [
        ("swing.m4a", "forcepush-old1.ogg", 0.22, 0.08, 0.18),
        ("cleave.m4a", "forcepulse.ogg", 0.30, 0.10, 0.22),
        ("fire.m4a", "shot2.ogg", 0.78, 0.14, None),
        ("inferno.m4a", "flamethrower.ogg", 1.80, 0.25, None),
        ("meteor.m4a", "explode1.ogg", 1.45, 0.22, None),
        ("boom.m4a", "explode2.ogg", 1.25, 0.22, None),
        ("freeze.m4a", "freeze2.ogg", 1.15, 0.20, None),
        ("cast.m4a", "spell.ogg", 0.90, 0.16, None),
        ("blink.m4a", "teleport.ogg", 0.70, 0.14, None),
        ("wall.m4a", "magicshield.ogg", 0.65, 0.14, None),
        ("shoot.m4a", "shot.ogg", 0.38, 0.08, None),
        ("volley.m4a", "forcepush-old1.ogg", 0.36, 0.08, None),
        ("storm.m4a", "wind2.ogg", 1.50, 0.25, 0.25),
        ("dash.m4a", "forcepulse.ogg", 0.32, 0.08, 0.25),
        ("boon.m4a", "blessing3.ogg", 1.10, 0.20, None),
        ("pickup.m4a", "heal.ogg", 0.85, 0.18, None),
        ("box.m4a", "enchant.ogg", 0.72, 0.14, None),
        ("curse.m4a", "curse4.ogg", 0.90, 0.16, None),
        ("confusion.m4a", "confusion.ogg", 0.45, 0.10, None),
        ("dead.m4a", "magicfail2.ogg", 1.10, 0.20, None),
        ("horn.m4a", "entrance.ogg", 1.35, 0.22, None),
        ("cheer.m4a", "cheer-crowd.ogg", 2.10, 0.35, None),
    ]
    with zipfile.ZipFile(spells_zip) as z:
        for out_name, src_name, max_dur, fade_out, lp in spell_mapping:
            raw = z.read(src_name)
            if raw[:4] != b"RIFF":
                raise ValueError(f"{src_name} is not RIFF WAV")
            trim_and_encode_wav(raw, os.path.join(OUT_SFX, out_name), max_dur=max_dur, fade_out=fade_out, lowpass_alpha=lp)

    # Extract native OGG SFX from Kenney packs
    kenney_mapping = [
        ("door.ogg", "kenney_rpg-audio.zip", "Audio/doorOpen_1.ogg"),
        ("hit.ogg", "kenney_impact-sounds.zip", "Audio/impactPlate_medium_000.ogg"),
        ("thud.ogg", "kenney_impact-sounds.zip", "Audio/impactSoft_heavy_000.ogg"),
        ("hurt.ogg", "kenney_impact-sounds.zip", "Audio/impactPunch_heavy_001.ogg"),
        ("ui.ogg", "kenney_interface-sounds.zip", "Audio/click_002.ogg"),
        ("fb.ogg", "kenney_music-jingles.zip", "Audio/Steel jingles/jingles_STEEL00.ogg"),
        ("streak.ogg", "kenney_music-jingles.zip", "Audio/Steel jingles/jingles_STEEL02.ogg"),
        ("shutdown.ogg", "kenney_music-jingles.zip", "Audio/Hit jingles/jingles_HIT04.ogg"),
    ]
    for out_name, zip_name, inner_path in kenney_mapping:
        with zipfile.ZipFile(os.path.join(ASSETS_FREE, zip_name)) as zk:
            with open(os.path.join(OUT_SFX, out_name), "wb") as f:
                f.write(zk.read(inner_path))

    print(f"Built {len(spell_mapping)} M4A + {len(kenney_mapping)} OGG SFX in {OUT_SFX}")


if __name__ == "__main__":
    build_models()
    build_sfx()
