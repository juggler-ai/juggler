#!/bin/sh
#
# Adds Juggler to this user's desktop: an application-menu entry and the app
# icon, pointing at the juggler-app beside this script. The binaries stay where
# the tarball was unpacked, so move the directory first and run this from its
# new home; running it again after a move or an upgrade rewrites the entry.
#
#   ./install.sh               install for this user (~/.local/share)
#   ./install.sh --uninstall   remove what it installed
#
# The window finds its icon through this entry: GTK4 shows no icon a program
# sets itself, so a shell matches the window to <APP_ID>.desktop — by the
# juggler-app's Linux ApplicationID (APP_ID), or by its program name (WM_CLASS,
# the Wayland app_id) against StartupWMClass — and draws the icon the entry
# names from the icon theme. Without it every Juggler window has the generic
# icon. Both values are juggler-app's LinuxOptions (cmd/juggler-app/app_state.go).

set -eu

APP_ID=studio.juggler.Juggler
WM_CLASS=Juggler

here=$(cd "$(dirname "$0")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
apps=$data/applications
icons=$data/icons
entry=$apps/$APP_ID.desktop

refresh() {
	# Both caches are optional: shells that keep none rescan the directories.
	if command -v update-desktop-database >/dev/null 2>&1; then
		update-desktop-database -q "$apps" 2>/dev/null || :
	fi
	for tool in gtk4-update-icon-cache gtk-update-icon-cache; do
		if command -v "$tool" >/dev/null 2>&1; then
			"$tool" -q -f -t "$icons/hicolor" 2>/dev/null || :
			break
		fi
	done
}

if [ "${1:-}" = "--uninstall" ]; then
	rm -f "$entry"
	for f in "$icons"/hicolor/*/apps/"$APP_ID".png; do
		[ -e "$f" ] && rm -f "$f"
	done
	refresh
	echo "Removed Juggler from the application menu."
	exit 0
fi
if [ $# -gt 0 ]; then
	echo "usage: $0 [--uninstall]" >&2
	exit 2
fi

if [ ! -x "$here/juggler-app" ]; then
	echo "no juggler-app beside $0 — run the install.sh from the unpacked tarball" >&2
	exit 1
fi
if [ ! -d "$here/icons/hicolor" ]; then
	echo "no icons/ beside $0 — run the install.sh from the unpacked tarball" >&2
	exit 1
fi

# Exec= quotes its program the desktop-entry way: inside double quotes, ",
# `, $ and \ take a backslash, and the value's own string escaping then
# doubles every backslash; a literal % is written %%.
exec_path=$(printf '%s' "$here/juggler-app" |
	sed -e 's/\\/\\\\\\\\/g' -e 's/["`$]/\\\\&/g' -e 's/%/%%/g')
# TryExec= is a plain string, so only the string escaping applies. It hides the
# entry once that juggler-app is gone (a deleted directory, a `make clean`).
tryexec_path=$(printf '%s' "$here/juggler-app" | sed -e 's/\\/\\\\/g')

mkdir -p "$apps"
for dir in "$here"/icons/hicolor/*/apps; do
	size=$(basename "$(dirname "$dir")")
	mkdir -p "$icons/hicolor/$size/apps"
	cp "$dir/$APP_ID.png" "$icons/hicolor/$size/apps/$APP_ID.png"
done

tmp=$entry.tmp.$$
cat >"$tmp" <<EOF
[Desktop Entry]
Type=Application
Name=Juggler
GenericName=AI Code Agent
Comment=AI code agent for your projects
TryExec=$tryexec_path
Exec="$exec_path"
Icon=$APP_ID
StartupWMClass=$WM_CLASS
Terminal=false
Categories=Development;IDE;
Keywords=AI;agent;code;LLM;
EOF
mv "$tmp" "$entry"

refresh
echo "Added Juggler to the application menu ($entry)."
