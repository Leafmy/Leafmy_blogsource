#!/usr/bin/env bash
echo "=== SUDO ==="
if sudo -n true 2>/dev/null; then echo "PASSWORDLESS_SUDO=yes"; else echo "PASSWORDLESS_SUDO=no (password required or no sudo)"; fi
echo "=== APT SOURCES ==="
grep -rhE '^deb ' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -5
ls /etc/apt/sources.list.d/ 2>/dev/null
echo "=== APT CACHE AGE ==="
stat -c '%y' /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo "(never updated)"
echo "=== PATH (interop check) ==="
echo "$PATH" | tr ':' '\n' | grep -n . | head -40
echo "=== WINDOWS NODE SHADOW ==="
ls -la /mnt/c/Users/Leaf_/AppData/Local/Programs/DSH\ Desktop/resources/app/node_modules/node/bin/node 2>/dev/null && echo "CONFIRMED: Windows node on PATH"
echo "=== PROJECT ON /mnt/c ==="
P="/mnt/c/Users/Leaf_/Desktop/All In/leafmy-top"
du -sh "$P" 2>/dev/null
du -sh "$P/node_modules" 2>/dev/null
cd "$P" && git rev-parse --abbrev-ref HEAD 2>/dev/null && git log --oneline -3 2>/dev/null
git remote -v 2>/dev/null
echo "--- node_modules entry count ---"
ls "$P/node_modules" 2>/dev/null | wc -l
echo "=== HEXO CLI PRESENT? ==="
ls "$P/node_modules/.bin/" 2>/dev/null | head -20
echo "=== GIT GLOBAL CONFIG ==="
git config --global --list 2>/dev/null || echo "(empty)"
echo "=== TIMEZONE/LOCALE ==="
timedatectl 2>/dev/null | head -3
echo "=== DONE ==="
