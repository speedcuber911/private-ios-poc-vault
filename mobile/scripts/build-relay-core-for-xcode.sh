#!/bin/sh

set -eu

if [ "${OVERRIDE_KOTLIN_BUILD_IDE_SUPPORTED:-}" = "YES" ]; then
  echo "Skipping Gradle build because the IDE already built RelayCore"
  exit 0
fi

relay_script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
relay_mobile_root="$(CDPATH= cd -- "$relay_script_dir/.." && pwd)"

relay_brew_bin="$(command -v brew 2>/dev/null || true)"
if [ -z "$relay_brew_bin" ]; then
  for relay_brew_candidate in \
    /opt/homebrew/bin/brew \
    /usr/local/bin/brew \
    /Users/local/Homebrew/bin/brew
  do
    if [ -x "$relay_brew_candidate" ]; then
      relay_brew_bin="$relay_brew_candidate"
      break
    fi
  done
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME:-}/bin/java" ]; then
  if [ -n "$relay_brew_bin" ]; then
    relay_brew_java_home="$("$relay_brew_bin" --prefix openjdk@17 2>/dev/null || true)/libexec/openjdk.jdk/Contents/Home"
    if [ -x "$relay_brew_java_home/bin/java" ]; then
      JAVA_HOME="$relay_brew_java_home"
    fi
  fi
fi

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME:-}/bin/java" ]; then
  for relay_java_home in \
    "$HOME/Library/Java/JavaVirtualMachines/openjdk-17.jdk/Contents/Home" \
    /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
    /Users/local/Homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  do
    if [ -x "$relay_java_home/bin/java" ]; then
      JAVA_HOME="$relay_java_home"
      break
    fi
  done
fi

if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  PATH="$JAVA_HOME/bin:$PATH"
  export JAVA_HOME PATH
fi

if ! command -v java >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
  echo "error: RelayCore's Xcode build requires JDK 17. Xcode Cloud installs it from ios/POCVault/ci_scripts/ci_post_clone.sh." >&2
  exit 1
fi

cd "$relay_mobile_root"
exec ./gradlew :relay-core:embedAndSignAppleFrameworkForXcode
