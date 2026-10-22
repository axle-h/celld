#!/bin/sh
# One HTTP exchange per connection. /redirect answers 302 to an absolute URL
# on another host; anything else answers the Host and path it was sent.
read -r method path version
host=""
while read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  [ -z "$line" ] && break
  case "$line" in
    [Hh]ost:*) host=$(printf '%s' "${line#*:}" | tr -d ' ') ;;
  esac
done
if [ "$path" = "/redirect" ]; then
  printf 'HTTP/1.1 302 Found\r\nLocation: http://elsewhere.test:9999/landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
else
  body="host=$host path=$path"
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${#body}" "$body"
fi
