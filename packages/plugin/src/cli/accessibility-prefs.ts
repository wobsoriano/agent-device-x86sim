/**
 * A Python 3 program that reads or sets the phone's accessibility preferences. x86Sim needs
 * Python 3, so it is on every machine that runs this. The Python standard library reads and
 * writes binary property lists, which Node does not.
 *
 * `check <file>` prints `true` when both keys are on. `enable <file>` turns them on, keeps every
 * other key, and replaces the file in one rename so the phone never sees half a file. Run it
 * only while the phone is stopped, because a running phone's `cfprefsd` would overwrite it.
 */
export const ACCESSIBILITY_PREFS_SCRIPT = `
import os, plistlib, sys, tempfile
mode, path = sys.argv[1], sys.argv[2]
KEYS = ("ApplicationAccessibilityEnabled", "AccessibilityEnabled")
try:
    with open(path, "rb") as f:
        prefs = plistlib.load(f)
except FileNotFoundError:
    prefs = {}
on = all(prefs.get(key) is True for key in KEYS)
if mode == "check":
    print("true" if on else "false")
elif not on:
    prefs.update({key: True for key in KEYS})
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=folder, prefix=".ax-prefs-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            plistlib.dump(prefs, f, fmt=plistlib.FMT_BINARY)
        os.chmod(temp, os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644)
        os.replace(temp, path)
    except BaseException:
        os.unlink(temp)
        raise
`;
