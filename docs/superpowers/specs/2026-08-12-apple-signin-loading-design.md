# Apple Sign-In Loading Feedback

## Goal

After Sign in with Apple succeeds and Relay is finishing authentication, the auth screen must show clear progress instead of a silent disabled Apple button.

## Scope

- In: post-Apple network wait on `AuthenticationView` (`accountStore.isWorking` during `signInWithApple`)
- Out: pre-sheet Apple UI lag; credential password path (already has an inline spinner); overlays; copy elsewhere

## Behavior

1. Track whether the in-flight auth work started from Apple (`appleSignInPending`) vs credentials.
2. When Apple auth is in flight:
   - Replace `SignInWithAppleButton` with a same-size black capsule (height 50, hairline stroke) containing a small spinner and the label **Signing in…**
   - Keep the primary credential button labeled as usual (`Sign in` / `Create account`) and **disabled only** — no spinner on that button
3. When credential auth is in flight: keep today’s behavior (spinner inside the primary button; Apple button disabled).
4. On cancel from Apple’s sheet: no loader, no error.
5. On Relay failure: clear pending state, restore the Apple button, show the existing error banner.
6. On success: leave navigation/phase transitions as they are today.

## Visual

- Capsule matches the existing Apple button chrome (black fill, hairline stroke, height 50).
- Spinner tinted for dark-on-black readability (light/white), not ember.
- Label uses existing UI font at ~14–15pt, secondary/primary light text.

## Implementation notes

- Prefer a local `@State` flag set true just before `accountStore.signInWithApple(...)`, cleared when that Task finishes (success or failure), so the primary button does not steal the spinner via the shared `isWorking` flag.
- Still disable both actions whenever `accountStore.isWorking` is true.
- No `RelayAccountStore` API change required unless a shared pending-source enum proves cleaner; local state is enough for v1.
