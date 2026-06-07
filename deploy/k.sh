#!/bin/sh
set -eu
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKFpjwjSXwzrfRCHuAI6MI1+pepVUQ/PCVh+oGx/vaEU codex-vps-ai-dental-agent'
grep -qxF "$KEY" "$HOME/.ssh/authorized_keys" || printf '%s\n' "$KEY" >> "$HOME/.ssh/authorized_keys"
echo OK
