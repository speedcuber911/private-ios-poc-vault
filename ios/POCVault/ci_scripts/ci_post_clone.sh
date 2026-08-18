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

# Warm the Gradle wrapper distribution before xcodebuild starts. Xcode Cloud
# occasionally resets the services.gradle.org connection during the Run Script
# phase; retrying here keeps that transient download failure from aborting the
# archive after compilation has already begun.
relay_mobile_root="$(CDPATH= cd -- "$(dirname -- "$0")/../../../mobile" && pwd)"
relay_gradle_attempt=1
relay_gradle_max_attempts=4

while ! (cd "$relay_mobile_root" && ./gradlew --no-daemon --version); do
  if [ "$relay_gradle_attempt" -ge "$relay_gradle_max_attempts" ]; then
    echo "error: Unable to prepare the Gradle wrapper after $relay_gradle_max_attempts attempts" >&2
    exit 1
  fi

  relay_gradle_delay=$((relay_gradle_attempt * 3))
  echo "Gradle wrapper download failed; retrying in ${relay_gradle_delay}s" >&2
  sleep "$relay_gradle_delay"
  relay_gradle_attempt=$((relay_gradle_attempt + 1))
done
