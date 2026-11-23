#!/bin/sh
# Entry point of the updater image (10b spec 5.1). Compose runs the image as the Kainow folder's owner
# (KAINOW_UID:KAINOW_GID), a user id the image cannot know in advance. ssh-keygen, which git uses to check
# release signatures, refuses to run for a user id without a passwd entry, so one is supplied through
# nss_wrapper: a copy of /etc/passwd with that entry, in /tmp (the root file system is read-only).
set -e
if ! getent passwd "$(id -u)" >/dev/null 2>&1; then
  passwd_file="$(mktemp /tmp/kainow-passwd.XXXXXX)"
  cat /etc/passwd > "$passwd_file"
  echo "kainow:x:$(id -u):$(id -g):Kainow updater:${HOME:-/tmp}:/usr/sbin/nologin" >> "$passwd_file"
  export LD_PRELOAD=libnss_wrapper.so NSS_WRAPPER_PASSWD="$passwd_file" NSS_WRAPPER_GROUP=/etc/group
fi
exec docker-entrypoint.sh "$@"
