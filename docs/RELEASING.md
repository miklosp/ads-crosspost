# Releasing (macOS)

Unsigned, for contributors: `pnpm app:dist` (arm64 dmg in `dist/`).

Signed and notarized, arm64 + x64 dmgs:

```sh
op run --env-file=.env.op -- pnpm app:dist:signed
```

Needs:

- "Developer ID Application: Miklos Petravich (V378YWVH44)" in the login keychain.
- `.env.op`, copied from `.env.op.example`, pointing at a 1Password item with the App Store Connect
  API key: the `.p8` file attached, plus `key-id` and `issuer-id` fields.

`scripts/with-apple-key.sh` writes the `.p8` to a 0600 temp file for the build (electron-builder
wants `APPLE_API_KEY` as a path) and deletes it on exit.

Check a build: `spctl -a -vvv "dist/mac-arm64/Ads Crosspost.app"` should say
`source=Notarized Developer ID`.
