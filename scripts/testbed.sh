#!/usr/bin/env bash
#
# Start an isolated Shelved for testing: its own empty database in a temp
# directory, its own port, and never the live library.
#
#   scripts/testbed.sh start [port]   # prints the port once it answers
#   scripts/testbed.sh stop  [port]
#
# The cookie jar is left at /tmp/testbed-<port>.cookies, already signed in.
set -u
cmd=${1:-start}
port=${2:-4300}
log=/tmp/testbed-$port.log
pidfile=/tmp/testbed-$port.pid
jar=/tmp/testbed-$port.cookies

case "$cmd" in
  stop)
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
    rm -f "$pidfile"
    echo "stopped $port"
    ;;
  start)
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
    dir=$(mktemp -d)
    # Remember where it put its database, so a test can assert on what landed
    # there and not only on what the API said.
    echo "$dir" > "/tmp/testbed-$port.dir"
    # setsid detaches it from this shell so it survives the command returning.
    setsid env SHELVED_DATA="$dir" SHELVED_ALLOW_SETUP=1 PORT="$port" \
      node server/index.js > "$log" 2>&1 < /dev/null &
    echo $! > "$pidfile"

    for _ in $(seq 1 60); do
      if curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/api/auth/status"; then
        rm -f "$jar"
        curl -s -m 10 -c "$jar" -X POST "http://127.0.0.1:$port/api/auth/setup" \
          -H 'Content-Type: application/json' -d '{"password":"testbed-password"}' > /dev/null

        # Copy the real metadata keys across. Without them the testbed falls
        # back to the keyless providers, which is a different code path from
        # the one actually running.
        keys=$(node -e '
          const { DatabaseSync } = require("node:sqlite");
          try {
            const db = new DatabaseSync("data/shelved.db", { readOnly: true });
            const out = {};
            for (const r of db.prepare("SELECT key, value FROM settings").all()) {
              if (["tmdb_api_key", "omdb_api_key", "google_books_api_key", "bgg_api_key"].includes(r.key) && r.value) out[r.key] = r.value;
            }
            console.log(JSON.stringify(out));
          } catch { console.log("{}"); }
        ' 2>/dev/null)
        if [ -n "$keys" ] && [ "$keys" != "{}" ]; then
          curl -s -m 10 -b "$jar" -X PUT "http://127.0.0.1:$port/api/settings" \
            -H 'Content-Type: application/json' -d "$keys" > /dev/null
        fi

        echo "$port"
        exit 0
      fi
      sleep 0.5
    done
    echo "testbed failed to start; see $log" >&2
    tail -5 "$log" >&2
    exit 1
    ;;
esac
