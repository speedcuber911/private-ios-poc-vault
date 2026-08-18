#!/bin/sh

set -eu

if [ "${CI_XCODE_CLOUD:-}" != "TRUE" ]; then
  echo "Skipping Xcode Cloud dependency setup outside Xcode Cloud"
  exit 0
fi

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

if [ -z "$relay_brew_bin" ]; then
  echo "error: Homebrew is required to install JDK 17 in Xcode Cloud" >&2
  exit 1
fi

if ! "$relay_brew_bin" list --versions openjdk@17 >/dev/null 2>&1; then
  "$relay_brew_bin" install openjdk@17
fi

relay_java_home="$("$relay_brew_bin" --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
if [ ! -x "$relay_java_home/bin/java" ]; then
  echo "error: Xcode Cloud installed openjdk@17 but Java was not found at $relay_java_home" >&2
  exit 1
fi

# The later xcodebuild Run Script is a fresh shell. Exporting here is not
# enough on its own; also pin a user-local JVM so java_home and the Gradle
# helper can find JDK 17 without sudo or a workflow env var.
mkdir -p "$HOME/Library/Java/JavaVirtualMachines"
ln -sfn "$("$relay_brew_bin" --prefix openjdk@17)/libexec/openjdk.jdk" \
  "$HOME/Library/Java/JavaVirtualMachines/openjdk-17.jdk"

JAVA_HOME="$relay_java_home"
PATH="$JAVA_HOME/bin:$PATH"
export JAVA_HOME PATH

"$JAVA_HOME/bin/java" -version
