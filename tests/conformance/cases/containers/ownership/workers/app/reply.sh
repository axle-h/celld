#!/bin/sh
# One HTTP exchange per connection: skip the request, answer the NAME that
# the object passed to start().
while read -r line; do
  [ -z "$(printf '%s' "$line" | tr -d '\r')" ] && break
done
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${#NAME}" "$NAME"
