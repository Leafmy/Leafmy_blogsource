#!/usr/bin/env bash
echo "=== /etc/sudoers (effective) ==="
grep -vE '^[[:space:]]*#|^[[:space:]]*$' /etc/sudoers
echo "=== /etc/sudoers.d ==="
ls -la /etc/sudoers.d/ 2>/dev/null
for f in /etc/sudoers.d/*; do
  [ -f "$f" ] || continue
  echo "--- $f ---"
  cat "$f"
done
echo "=== visudo -c ==="
visudo -c 2>&1
echo "=== sudo -n true (as root) ==="
sudo -n true; echo "exit=$?"
echo "=== id leaf ==="
id leaf
echo "=== sudo -n -u leaf test ==="
sudo -n -u leaf true; echo "exit=$?"
echo "=== perms ==="
ls -la /etc/sudoers
