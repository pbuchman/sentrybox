#!/bin/sh

content_length=0
carriage_return="$(printf '\r')"
while IFS= read -r line; do
  line="${line%"${carriage_return}"}"
  if [ -z "${line}" ]; then
    break
  fi
  case "${line}" in
    [Cc]ontent-[Ll]ength:*) content_length="${line#*: }" ;;
  esac
done

case "${content_length}" in
  '' | *[!0-9]*) content_length=0 ;;
esac
if [ "${content_length}" -gt 0 ]; then
  dd bs=1 count="${content_length}" of=/dev/null 2>/dev/null
fi

printf 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
