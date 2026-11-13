#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage: ./build.sh [options] [-- docker-build-options]

Options:
  --compose-file FILE  Update an image entry in this Compose file after building.
  --service NAME       Update only this service instead of every detected MCP service.
  -h, --help           Show this help.

Examples:
  ./build.sh
  ./build.sh -- --no-cache --pull
  ./build.sh --compose-file /srv/affine/compose.yml
  ./build.sh --compose-file /srv/affine/compose.yml --service affine_mcp_miyu
EOF
}

invocation_dir=$(pwd)
compose_file=
compose_service=
compose_services=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --compose-file)
      [ "$#" -ge 2 ] || { echo "Error: --compose-file requires a path." >&2; exit 2; }
      compose_file=$2
      shift 2
      ;;
    --service)
      [ "$#" -ge 2 ] || { echo "Error: --service requires a name." >&2; exit 2; }
      compose_service=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ -z "$compose_file" ] && [ -n "$compose_service" ]; then
  echo "Error: --service requires --compose-file." >&2
  exit 2
fi

if [ -n "$compose_file" ]; then
  case "$compose_file" in
    /*) ;;
    *) compose_file="${invocation_dir}/${compose_file}" ;;
  esac
  [ -f "$compose_file" ] || { echo "Error: Compose file not found: $compose_file" >&2; exit 2; }

  if [ -z "$compose_service" ]; then
    detected_services=$(awk '
      function indentation(line, match_at) {
        match_at = match(line, /[^ \t]/)
        return match_at ? match_at - 1 : length(line)
      }
      {
        content = $0
        sub(/[ \t]*#.*/, "", content)
        trimmed = content
        sub(/^[ \t]*/, "", trimmed)
        sub(/[ \t]*$/, "", trimmed)
        current_indent = indentation($0)

        for (level in parent) {
          if (level >= current_indent) delete parent[level]
        }
        if (trimmed ~ /^[^:]+:[ \t]*$/) {
          name = trimmed
          sub(/:[ \t]*$/, "", name)
          parent[current_indent] = name
        } else if (trimmed ~ /^image[ \t]*:/ && trimmed ~ /affine-mcp-server/) {
          nearest_indent = -1
          nearest_name = ""
          for (level in parent) {
            numeric_level = level + 0
            if (numeric_level < current_indent && numeric_level > nearest_indent) {
              nearest_indent = numeric_level
              nearest_name = parent[level]
            }
          }
          if (nearest_name != "") print nearest_name
        }
      }
    ' "$compose_file" | sort -u)

    detected_count=$(printf '%s\n' "$detected_services" | awk 'NF { count += 1 } END { print count + 0 }')
    if [ "$detected_count" -eq 0 ]; then
      echo "Error: no service using an affine-mcp-server image was found in $compose_file" >&2
      echo "Specify it explicitly with --service NAME." >&2
      exit 2
    elif [ "$detected_count" -eq 1 ]; then
      compose_services=$detected_services
      echo "Detected Compose service: ${compose_services}"
    else
      compose_services=$detected_services
      echo "Detected Compose services:"
      printf '  %s\n' $detected_services
    fi
  else
    compose_services=$compose_service
  fi
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not available in PATH." >&2
  exit 1
fi

revision=$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')
image_repository=${IMAGE_REPOSITORY:-affine-mcp-server}
image_tag=${IMAGE_TAG:-local-${revision}}
image_name="${image_repository}:${image_tag}"

echo "Building ${image_name}..."
docker build \
  --label "org.opencontainers.image.revision=${revision}" \
  --tag "$image_name" \
  "$@" \
  .

image_id=$(docker image inspect "$image_name" --format '{{.Id}}')

if [ -n "$compose_file" ]; then
  compose_tmp=$(mktemp "${compose_file}.tmp.XXXXXX")
  trap 'rm -f "$compose_tmp"' EXIT HUP INT TERM

  if ! awk -v services="$compose_services" -v image="$image_name" '
    function indentation(line, match_at) {
      match_at = match(line, /[^ \t]/)
      return match_at ? match_at - 1 : length(line)
    }
    BEGIN {
      service_count = split(services, service_names, "\n")
      for (service_index = 1; service_index <= service_count; service_index += 1) {
        wanted[service_names[service_index]] = 1
      }
    }
    {
      content = $0
      sub(/[ \t]*#.*/, "", content)
      trimmed = content
      sub(/^[ \t]*/, "", trimmed)
      sub(/[ \t]*$/, "", trimmed)
      current_indent = indentation($0)

      if (in_service && trimmed != "" && current_indent <= service_indent) {
        in_service = 0
      }
      candidate = trimmed
      sub(/:[ \t]*$/, "", candidate)
      if (!in_service && (candidate in wanted) && trimmed ~ /:[ \t]*$/) {
        current_service = candidate
        in_service = 1
        service_indent = current_indent
        found[current_service] = 1
      } else if (in_service && trimmed ~ /^image[ \t]*:/) {
        prefix = substr($0, 1, current_indent)
        print prefix "image: " image
        replaced[current_service] += 1
        next
      }
      print
    }
    END {
      failed = 0
      for (service in wanted) {
        if (!found[service]) {
          print "Error: service not found in Compose file: " service > "/dev/stderr"
          failed = 1
        } else if (replaced[service] != 1) {
          print "Error: expected exactly one image entry for service " service ", found " replaced[service] > "/dev/stderr"
          failed = 1
        }
      }
      if (failed) exit 4
    }
  ' "$compose_file" > "$compose_tmp"; then
    exit 1
  fi

  cp "$compose_tmp" "$compose_file"
  rm -f "$compose_tmp"
  trap - EXIT HUP INT TERM
  echo "Updated Compose service(s) in ${compose_file}:"
  printf '  %s\n' $compose_services
fi

cat <<EOF

Build complete.

Image tag: ${image_name}
Image ID:  ${image_id}

Use this in docker-compose.yml:

    image: ${image_name}

Verify the running container uses this exact image:

    docker inspect -f '{{.Image}}' <container>

The value above should equal:

    ${image_id}
EOF

if [ -n "$compose_file" ]; then
  compose_service_args=$(printf '%s\n' "$compose_services" | awk 'NF { printf "%s\"%s\"", separator, $0; separator = " " }')
  cat <<EOF

Recreate the updated service(s):

    docker compose -f "${compose_file}" up -d --no-deps --force-recreate ${compose_service_args}
EOF
else
  cat <<'EOF'

After updating Compose, recreate the MCP service:

    docker compose up -d --no-deps --force-recreate <service>
EOF
fi
