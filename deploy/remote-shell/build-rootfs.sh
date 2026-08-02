#!/bin/sh
set -eu

rootfs=${1:?usage: build-rootfs.sh /absolute/empty/rootfs}
case "$rootfs" in
  /*) ;;
  *) echo 'rootfs path must be absolute' >&2; exit 2 ;;
esac
if [ "$rootfs" = / ] || [ -e "$rootfs/bin" ] || [ -e "$rootfs/usr" ]; then
  echo 'rootfs target must be a dedicated empty directory' >&2
  exit 2
fi

install -d -m 0555 "$rootfs/bin" "$rootfs/etc" "$rootfs/home/demo" \
  "$rootfs/usr/bin"

copy_binary() {
  binary=$1
  destination="$rootfs$binary"
  install -D -m 0555 "$binary" "$destination"
  ldd "$binary" | awk '{ for (field = 1; field <= NF; field++) if ($field ~ /^\//) print $field }' |
    while IFS= read -r library; do
      install -D -m 0555 "$library" "$rootfs$library"
    done
}

for command in dash cat date env head id ls printf sleep stty uname wc whoami; do
  if [ "$command" = printf ]; then
    path=/usr/bin/printf
  else
    path=$(command -v "$command")
  fi
  copy_binary "$path"
done

ln -s ../usr/bin/dash "$rootfs/bin/sh"
install -m 0444 /build/deploy/remote-shell/rootfs/README.txt "$rootfs/README.txt"
if [ -r /etc/os-release ]; then
  install -m 0444 /etc/os-release "$rootfs/etc/os-release"
fi

printf '%s\n' \
  'root:x:0:0:root:/root:/usr/sbin/nologin' \
  'demo:x:65532:65532:Remote demo:/home/demo:/bin/sh' \
  > "$rootfs/etc/passwd"
printf '%s\n' \
  'root:x:0:' \
  'demo:x:65532:' \
  > "$rootfs/etc/group"
chmod 0444 "$rootfs/etc/passwd" "$rootfs/etc/group"

find "$rootfs" -type d -exec chmod 0555 {} +
if find "$rootfs" -xdev \( -type f -o -type d \) -perm /022 -print -quit |
  grep -q .; then
  echo 'rootfs contains a group- or world-writable path' >&2
  exit 1
fi
if find "$rootfs" -xdev -type f -perm /6000 -print -quit | grep -q .; then
  echo 'rootfs contains a setuid or setgid file' >&2
  exit 1
fi
