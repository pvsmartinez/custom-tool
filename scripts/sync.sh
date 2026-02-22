#!/bin/bash
# sync.sh - Quick sync: stage all changes, commit with a message, and push to origin/main

MESSAGE="${1:-sync: $(date '+%Y-%m-%d %H:%M')}"

cd "$(git rev-parse --show-toplevel)" || exit 1

git add -A
git commit -m "$MESSAGE"
git push origin main
