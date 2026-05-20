#!/usr/bin/env python3
from Xlib import X, XK, display, protocol
from Xlib.ext import xtest
import os
import re
import subprocess
import sys
import time


def keysym(name):
    ks = XK.string_to_keysym(name)
    if ks == 0:
        raise SystemExit(f"bad keysym {name}")
    return ks


def keycode(disp, name):
    return disp.keysym_to_keycode(keysym(name))


CHAR_KEYMAP = {
    "/": ("slash", False),
    "?": ("slash", True),
    ".": ("period", False),
    ">": ("period", True),
    ",": ("comma", False),
    "<": ("comma", True),
    ":": ("semicolon", True),
    ";": ("semicolon", False),
    "(": ("9", True),
    ")": ("0", True),
    '"': ("apostrophe", True),
    "'": ("apostrophe", False),
    "_": ("minus", True),
    "-": ("minus", False),
    "=": ("equal", False),
    "+": ("equal", True),
    "[": ("bracketleft", False),
    "{": ("bracketleft", True),
    "]": ("bracketright", False),
    "}": ("bracketright", True),
    "\\": ("backslash", False),
    "|": ("backslash", True),
    "`": ("grave", False),
    "~": ("grave", True),
    "!": ("1", True),
    "@": ("2", True),
    "#": ("3", True),
    "$": ("4", True),
    "%": ("5", True),
    "^": ("6", True),
    "&": ("7", True),
    "*": ("8", True),
    " ": ("space", False),
}


def char_key(ch):
    if ch in CHAR_KEYMAP:
        return CHAR_KEYMAP[ch]
    if ch.isalpha():
        return ch.lower(), ch.isupper()
    if ch.isdigit():
        return ch, False
    raise SystemExit(f"unsupported char {ch!r}")


def parse_combo(spec):
    shift = ctrl = alt = False
    key_name = None
    for part in [piece.strip() for piece in spec.split("+") if piece.strip()]:
        lowered = part.lower()
        if lowered in ("ctrl", "control"):
            ctrl = True
        elif lowered == "shift":
            shift = True
        elif lowered in ("alt", "meta"):
            alt = True
        else:
            key_name = part
    if not key_name:
        raise SystemExit(f"bad combo {spec!r}")
    return key_name, shift, ctrl, alt


def send_key(disp, name, shift=False, ctrl=False, alt=False):
    mods = []
    if shift:
        mods.append(keycode(disp, "Shift_L"))
    if ctrl:
        mods.append(keycode(disp, "Control_L"))
    if alt:
        mods.append(keycode(disp, "Alt_L"))
    for mod in mods:
        xtest.fake_input(disp, X.KeyPress, mod)
    xtest.fake_input(disp, X.KeyPress, keycode(disp, name))
    xtest.fake_input(disp, X.KeyRelease, keycode(disp, name))
    for mod in reversed(mods):
        xtest.fake_input(disp, X.KeyRelease, mod)
    disp.sync()


def type_text(disp, text):
    for ch in text:
        if ch == "\n":
            send_key(disp, "Return")
            time.sleep(0.05)
            continue
        name, shift = char_key(ch)
        send_key(disp, name, shift=shift)
        time.sleep(0.02)


def activate_window(disp, win_id):
    root = disp.screen().root
    atom_active = disp.intern_atom("_NET_ACTIVE_WINDOW")
    atom_current = disp.intern_atom("_NET_CURRENT_DESKTOP")
    atom_wm_desktop = disp.intern_atom("_NET_WM_DESKTOP")
    win = disp.create_resource_object("window", win_id)
    try:
        desktop = win.get_full_property(atom_wm_desktop, X.AnyPropertyType)
        if desktop and desktop.value is not None and len(desktop.value) > 0:
            root.send_event(
                protocol.event.ClientMessage(
                    window=root,
                    client_type=atom_current,
                    data=(32, [int(desktop.value[0]), X.CurrentTime, 0, 0, 0]),
                ),
                event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
            )
    except Exception:
        pass
    root.send_event(
        protocol.event.ClientMessage(
            window=win,
            client_type=atom_active,
            data=(32, [1, X.CurrentTime, win_id, 0, 0]),
        ),
        event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask,
    )
    disp.sync()


def window_geom(disp, win_id):
    win = disp.create_resource_object("window", win_id)
    geom = win.get_geometry()
    coords = win.translate_coords(disp.screen().root, 0, 0)
    return coords.x, coords.y, geom.width, geom.height


def list_windows():
    out = subprocess.run(
        ["xwininfo", "-root", "-tree"],
        check=False,
        text=True,
        capture_output=True,
        env=os.environ,
    )
    if out.returncode != 0:
        return []
    windows = []
    for line in out.stdout.splitlines():
        match = re.match(r'\s*(0x[0-9a-fA-F]+)\s+"([^"]*)".*?(\d+)x(\d+)\+', line)
        if not match:
            continue
        win_id, name, width, height = match.groups()
        windows.append((win_id, name, int(width), int(height)))
    return windows


def find_window(needle="Visual Studio Code"):
    prefer_code_window = not needle or needle == "Visual Studio Code"
    best_id = None
    best_area = -1
    best_name = ""
    for win_id, name, width, height in list_windows():
        if needle and needle not in name:
            continue
        if prefer_code_window and "Visual Studio Code" not in name and "Code" not in name:
            continue
        area = width * height
        if area > best_area or (area == best_area and name > best_name):
            best_id = win_id
            best_area = area
            best_name = name
    return best_id


def active_window_id(disp):
    atom_active = disp.intern_atom("_NET_ACTIVE_WINDOW")
    prop = disp.screen().root.get_full_property(atom_active, X.AnyPropertyType)
    if not prop or prop.value is None or len(prop.value) == 0:
        return None
    win_id = int(prop.value[0])
    if win_id == 0:
        return None
    return win_id


def wm_state_names(disp, win_id):
    atom_state = disp.intern_atom("_NET_WM_STATE")
    win = disp.create_resource_object("window", win_id)
    prop = win.get_full_property(atom_state, X.AnyPropertyType)
    if not prop or prop.value is None:
        return []
    return [disp.get_atom_name(int(atom)) for atom in prop.value]


def click(disp, button=1, shift=False, ctrl=False, alt=False):
    mods = []
    if shift:
        mods.append(keycode(disp, "Shift_L"))
    if ctrl:
        mods.append(keycode(disp, "Control_L"))
    if alt:
        mods.append(keycode(disp, "Alt_L"))
    for mod in mods:
        xtest.fake_input(disp, X.KeyPress, mod)
    xtest.fake_input(disp, X.ButtonPress, button)
    xtest.fake_input(disp, X.ButtonRelease, button)
    for mod in reversed(mods):
        xtest.fake_input(disp, X.KeyRelease, mod)
    disp.sync()


def set_wm_state(disp, win_id, atoms, action=1):
    root = disp.screen().root
    atom_state = disp.intern_atom("_NET_WM_STATE")
    atom_values = [disp.intern_atom(name) for name in atoms]
    while len(atom_values) < 2:
        atom_values.append(0)
    event = protocol.event.ClientMessage(
        window=disp.create_resource_object("window", win_id),
        client_type=atom_state,
        data=(32, [action, atom_values[0], atom_values[1], 1, 0]),
    )
    root.send_event(event, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    disp.sync()


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: keysend.py <activate|active-window|find-window|wait-window|window-geom|wm-state|fullscreen-window|maximize-window|key|combo|repeat-key|type|move|click> ...")
    disp = display.Display()
    root = disp.screen().root
    cmd = sys.argv[1]
    if cmd == "activate":
        activate_window(disp, int(sys.argv[2], 0))
    elif cmd == "active-window":
        win_id = active_window_id(disp)
        if win_id is None:
            raise SystemExit(1)
        print(hex(win_id))
    elif cmd == "find-window":
        needle = sys.argv[2] if len(sys.argv) > 2 else "Visual Studio Code"
        win_id = find_window(needle)
        if not win_id:
            raise SystemExit(1)
        print(win_id)
    elif cmd == "wait-window":
        timeout = float(sys.argv[2])
        needle = sys.argv[3] if len(sys.argv) > 3 else "Visual Studio Code"
        deadline = time.time() + timeout
        while time.time() < deadline:
            win_id = find_window(needle)
            if win_id:
                print(win_id)
                return
            time.sleep(0.2)
        raise SystemExit(1)
    elif cmd == "type":
        time.sleep(0.2)
        type_text(disp, sys.argv[2])
    elif cmd == "key":
        send_key(
            disp,
            sys.argv[2],
            shift="--shift" in sys.argv,
            ctrl="--ctrl" in sys.argv,
            alt="--alt" in sys.argv,
        )
    elif cmd == "combo":
        key_name, shift, ctrl, alt = parse_combo(sys.argv[2])
        send_key(disp, key_name, shift=shift, ctrl=ctrl, alt=alt)
    elif cmd == "repeat-key":
        count = int(sys.argv[2])
        key_name = sys.argv[3]
        shift = "--shift" in sys.argv
        ctrl = "--ctrl" in sys.argv
        alt = "--alt" in sys.argv
        delay = 0.02
        for arg in sys.argv[4:]:
            if arg.startswith("--delay="):
                delay = float(arg.split("=", 1)[1])
        for _ in range(max(0, count)):
            send_key(disp, key_name, shift=shift, ctrl=ctrl, alt=alt)
            time.sleep(delay)
    elif cmd == "move":
        root.warp_pointer(int(sys.argv[2]), int(sys.argv[3]))
        disp.sync()
    elif cmd == "move-window":
        win_id = int(sys.argv[2], 0)
        rel_x = int(sys.argv[3])
        rel_y = int(sys.argv[4])
        abs_x, abs_y, _, _ = window_geom(disp, win_id)
        root.warp_pointer(abs_x + rel_x, abs_y + rel_y)
        disp.sync()
    elif cmd == "window-geom":
        x, y, width, height = window_geom(disp, int(sys.argv[2], 0))
        print(f"{x} {y} {width} {height}")
    elif cmd == "wm-state":
        states = wm_state_names(disp, int(sys.argv[2], 0))
        print(" ".join(states))
    elif cmd == "fullscreen-window":
        set_wm_state(disp, int(sys.argv[2], 0), ["_NET_WM_STATE_FULLSCREEN"])
    elif cmd == "maximize-window":
        set_wm_state(
            disp,
            int(sys.argv[2], 0),
            ["_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ"],
        )
    elif cmd == "click":
        button = int(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else 1
        click(
            disp,
            button=button,
            shift="--shift" in sys.argv,
            ctrl="--ctrl" in sys.argv,
            alt="--alt" in sys.argv,
        )
    elif cmd == "click-window":
        win_id = int(sys.argv[2], 0)
        rel_x = int(sys.argv[3])
        rel_y = int(sys.argv[4])
        button = int(sys.argv[5]) if len(sys.argv) > 5 and not sys.argv[5].startswith("--") else 1
        abs_x, abs_y, _, _ = window_geom(disp, win_id)
        root.warp_pointer(abs_x + rel_x, abs_y + rel_y)
        disp.sync()
        click(
            disp,
            button=button,
            shift="--shift" in sys.argv,
            ctrl="--ctrl" in sys.argv,
            alt="--alt" in sys.argv,
        )
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
